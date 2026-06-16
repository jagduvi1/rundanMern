# Design proposal — consolidated invite & identity model

Status: **P0 + P1 + P2 implemented** (PRs stacked). Deferred from P2 (documented
below): member-token hashing-at-rest, full friends consent model, canUpload
event-scoping.
Scope: how people are invited, added, and join an event; how a login connects to a
roster person; how management authority is granted. Grounded in the audit of the
current code (5 mechanisms, 35 confirmed findings: 3 critical, 2 high, 5 medium).

---

## 1. The problem

Today there are **five** ways a person attaches to an event, and the only thing
linking "a roster person an admin created" to "a real human who logs in" is
**fragile, silent, exact-name matching** in one function (`resolveRosterUser`):

| Mechanism | Creates | Auth to do it |
|---|---|---|
| Email/friend **invite** (`Invite`) | `EventMember` (non-admin) | event manager |
| **Roster set** `PUT /events/:id/members` | `EventMember` rows | event manager |
| **Account co-admins** `POST/DELETE /admins` | `Event.owner/admins` | any manager |
| **Anonymous join** `…/by-code/:code/join` | free-name `Participant` | join code only |
| **Anonymous claim** `…/by-code/:code/claim` | team `Participant` + returns `memberToken` | **join code only** |

Two root issues fall out of this:

1. **Identity has no single source of truth.** A roster `User{name:"Johan"}`, an
   `Account`, and the human are only connected if the human's *display name happens
   to exactly equal* the roster name (and that name isn't already linked). Otherwise
   you get a duplicate `Johan (2)`, an unclaimed slot, or a silent merge onto the
   *wrong* same-named person.

2. **Playing identity and management authority are conflated.** `claim` is
   `optionalAuth` yet returns the member's `memberToken` **and** `isEventAdmin`
   ([events.js:1034‑1090](../backend/src/routes/events.js#L1034)) — so anyone with the
   join code can tap an **admin** roster name and receive a co-host credential →
   event takeover (the three CRITICAL findings).

## 2. Threat model (what tempers the design)

This is a **private, mobile-first party-games app**. The "attacker" is usually a
guest at your party, and the join code is meant to be shared widely (spoken, QR'd).
So the design must keep the **walk-up, no-login** player experience — you should
still be able to tap your name and play — while ensuring that **doing so never
grants management authority**, and that scores/identity can't be trivially hijacked.

## 3. Guiding principle

> **Separate "playing identity" (low-friction, anonymous is fine) from "management
> authority" (must be an authenticated, explicitly-granted role).**

The current bug is that `claim` mixes them. Split them:

- **Play token** (`Participant` / team token): cheap, anonymous-claimable, lets you
  answer/score/chat *as a team*. Fine to hand out on a join code.
- **Manage token** (admin `EventMember` / account co-admin): never issued to an
  anonymous caller. Requires a logged-in `Account` that the host promoted, or a
  one-time per-member secret the host hands out deliberately.

## 4. Target model

Keep the four entities; make the **link explicit** and give each a single job:

- **`User`** — a roster person (name only). Source of cross-event score attribution.
- **`Account`** — a login. Linked 1:1 to a `User` **only via an explicit, confirmed
  step** (never by name-guess).
- **`EventMember`** — `User`'s membership in an event + a device token. `isAdmin`
  ⇒ co-host. Token becomes a **hashed, rotatable** secret.
- **`Participant`** — an anonymous per-activity device/team session (play only).

### The "identity ladder" (one clear path)
```
walk-up player ──tap your name / free-name──▶ Participant (play token)         [anonymous OK]
        │
        └─ "this is my account" ──login + confirm──▶ Account.userId = thisUser  [explicit link]

host promotes a roster person ──▶ EventMember.isAdmin = true                    [manage token, host action]
account promoted to co-host    ──▶ Event.admins += account                      [manage authority]
```

## 5. Concrete changes

### P0 — close the takeover holes (security, ship first)
1. **`claim` never returns a manage token to an anonymous caller.**
   - Keep **"Spela som mig"**: resolve `userId` from `req.user.account.userId`
     (authenticated) → may return `memberToken` (it's *their own* membership).
   - **Anonymous roster claim** (tap a name): return only the **team play token**
     (`Participant`/team) and the slots — **drop `memberToken` and `isEventAdmin`
     from the response** for unauthenticated callers.
   - To claim a roster slot that is an **admin**, require login (or a per-member PIN,
     below). An anonymous tap can never yield admin.
2. **Redact roster `userId`s and `adminUserIds` for non-managers** in
   `GET /events/by-code/:code` (today only `owner/coAdmins` are redacted) so the
   admin set isn't an open directory.
3. **Host "play for a player" becomes a privileged endpoint**:
   `POST /events/:id/proxy/:userId` gated by `eventManager`, returns the proxied
   tokens only to the verified host (the frontend overlay already exists — just
   point it at this instead of the public `claim`).

### P1 — fix identity linking (stop the silent merge / duplicate-Johan)
4. **Invites carry the target roster `userId`.** When a host invites someone they
   can attach it to the roster person they already created ("invite **Johan**").
   Accept then binds the account to **that** `User` — no name guessing.
5. **Never auto-bind to a pre-existing same-named `User`.** In `resolveRosterUser`,
   if `account.userId` is unset and no invite designates a user, **create a fresh
   roster User** (dedupe with the `(n)` suffix already present). Linking to an
   existing roster person is a **deliberate, confirmed** action only.
6. **Add an explicit "claim / link my identity" confirmation** for the walk-up case:
   when a logged-in user taps a roster name, show *"Link this account to **Johan**?"*
   and only then set `account.userId` (with the existing hijack guard).

### P2 — harden + tidy
7. **Member tokens**: store a **hash** (compare hashes on `x-rundan-member`), add a
   per-event/per-member **revocation counter** (mirror `Account.tokenVersion`), and
   **rotate on demote** so a removed co-host's old device secret stops working.
8. **Scope `canUpload`** to the event being acted on (today an admin member token for
   *any* event authorizes uploads globally).
9. **Friends**: add a pending/accepted/blocked status + a **rotatable friend code**
   (today a leaked code permanently allows forced friend-adds), and stop echoing a
   friend's **email** back to the inviting host.
10. **Member-management UI**: re-derive the member/admin selection from the event
    prop on reload (today it's last-writer-wins on stale local state).

## 6. Claim model — DECIDED: open by default, PIN-protected on demand, QR handoff

The chosen model (best of both): claiming a roster name to *play* is **open by
default**, but protected by a per-member **claim PIN** in two cases:

- **Every admin (co-host) member is ALWAYS PIN-protected** — you cannot claim an
  admin identity (and thus receive its management token) without the PIN. This is
  what closes the critical takeover.
- **The host can set a PIN on any specific non-admin user** they want protected
  (e.g. a competitive player whose score shouldn't be impersonated).

A member with no PIN stays freely claimable (walk-up play preserved). To hand a
protected identity to the *right* person without reading a PIN aloud, the host can
**generate a per-member QR code** — it encodes a claim deep-link
(`/e/<eventId>?claimUser=<userId>&pin=<pin>`); the right person scans it and is
claimed automatically. The PIN value is visible only to managers.

This also fixes the host **"play for a player"** proxy for free: the host holds all
PINs, so the existing proxy claim passes the member's PIN; a non-host cannot.

## 7. Migration / live-deploy notes

- The app is **live** (rundan.jeklund.dev). Existing `memberToken`s live in players'
  `localStorage`. Hashing tokens (P2.7) must be **forward-compatible**: hash on next
  issue, or do a one-time backfill that hashes existing tokens — don't invalidate
  active party sessions mid-event.
- P0 is backward-compatible for *players* (they still tap a name and play); it only
  removes the manage-token from anonymous responses, which only an attacker relied on.
- P1 changes invite semantics; existing pending invites still accept (they just won't
  carry a `userId` and fall to "create fresh user").

## 8. Phasing (mapped to audit findings)

| Phase | Items | Closes |
|---|---|---|
| **P0** (security PR) | 1–3 | 3× CRITICAL (claim takeover/impersonation) + 1× HIGH (userId exposure) |
| **P1** (identity) | 4–6 | 2× MEDIUM (silent name-merge / duplicate person) |
| **P2** (hardening) | 7–10 | 1× HIGH (token lifecycle) + several LOW (canUpload, friends, stale UI) |

## 9. Decisions — MADE

1. **Claim model** — open by default; **PIN-protect all admins + any user the host
   chooses**; host-generated **QR** for secure handoff (§6).
2. **Keep anonymous free-name join.**
3. **Ship P0 now** (the PIN+QR secure-claim), then P1/P2 separately.

### P0 build (this pass)
- `EventMember.claimPin` (nullable). Admins always get one (auto-generated, incl. a
  lazy backfill for existing admins on first claim/members-save so the live app is
  protected immediately).
- `POST /by-code/:code/claim { userId, pin? }` — require the PIN (constant-time)
  whenever the target member has one; otherwise open. Never issue a manage token to
  a caller who failed the PIN.
- Per-member PIN admin: auto-PIN on admin promotion; `PUT /events/:id/members/:userId/pin`
  (manager-gated) to set/clear a user's PIN.
- Event DTO exposes per-member `needsPin` (all callers) and `pin` (managers only,
  stripped by `redactManagement`).
- Frontend: PIN prompt when claiming a protected member; host roster shows/sets PINs
  + a **Show QR** button; Event page auto-claims from a `?claimUser=&pin=` deep link;
  host proxy passes the PIN.
