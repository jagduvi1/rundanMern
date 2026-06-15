const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const Account = require('../models/Account');
const Token = require('../models/Token');
const emailService = require('../services/email');
const { requireAuth } = require('../middleware/auth');
const env = require('../config/env');
const magicLink = require('../services/magicLink');

// Host/admin account auth — the Glosan template adapted to rundan's Account
// model. Players never use this (they get anonymous participant tokens). The
// first account to register becomes the bootstrap super-admin.
const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many attempts, please try again later' }),
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many refresh attempts, please try again later' }),
});

const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Please wait before requesting another email.' }),
});

// ── Email-token helpers (only the SHA-256 hash is stored) ─────────────────────
const EMAIL_TOKEN_BYTES = 32;
const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 60 * 60 * 1000;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

const hashEmailToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function createEmailToken({ account, kind, ttlMs }) {
  const raw = crypto.randomBytes(EMAIL_TOKEN_BYTES).toString('hex');
  await Token.create({
    account: account._id,
    kind,
    tokenHash: hashEmailToken(raw),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return raw;
}

async function consumeEmailToken({ token, kind }) {
  if (!token || typeof token !== 'string') return null;
  const doc = await Token.findOneAndUpdate(
    { tokenHash: hashEmailToken(token), kind, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
  return doc || null;
}

function canonicalFrontendUrl() {
  const raw = env.frontendUrl || 'http://localhost:3000';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

async function sendVerifyEmail(account) {
  if (!emailService.isEnabled()) return false;
  const raw = await createEmailToken({ account, kind: 'verify-email', ttlMs: VERIFY_EMAIL_TTL_MS });
  const url = `${canonicalFrontendUrl()}/verify-email?token=${raw}`;
  await emailService.send({
    to: account.email,
    subject: `Confirm your email — ${env.appName}`,
    html: emailService.wrapTemplate({
      title: `Welcome to ${env.appName}!`,
      intro: `Confirm that ${account.email} is yours. This link is valid for 24 hours.`,
      ctaUrl: url,
      ctaLabel: 'Confirm my email',
    }),
    text: `Confirm your email: ${url}`,
  });
  return true;
}

async function sendResetPasswordEmail(account) {
  if (!emailService.isEnabled()) return false;
  const raw = await createEmailToken({ account, kind: 'reset-password', ttlMs: RESET_PASSWORD_TTL_MS });
  const url = `${canonicalFrontendUrl()}/reset-password?token=${raw}`;
  await emailService.send({
    to: account.email,
    subject: `Reset your password — ${env.appName}`,
    html: emailService.wrapTemplate({
      title: 'Reset your password',
      intro: 'Choose a new password. This link is valid for 60 minutes. Did not request it? Ignore this email.',
      ctaUrl: url,
      ctaLabel: 'Choose a new password',
    }),
    text: `Reset your password: ${url}`,
  });
  return true;
}

const noopJitter = () => new Promise((resolve) => setTimeout(resolve, 80 + crypto.randomInt(120)));

// Effective roles = the account's stored roles, plus 'admin' when the account's
// email is listed in ADMIN_EMAILS (env). Resolved fresh every time so env is the
// single source of truth for super-admin (no stale stored role).
const effectiveRoles = (account) => {
  const base = account.roles && account.roles.length > 0 ? account.roles : ['user'];
  return env.isAdminEmail(account.email) && !base.includes('admin') ? [...base, 'admin'] : base;
};

// The user payload returned to clients, with effective roles so the host UI
// reflects env-granted admin (AuthContext reads user.roles).
const userResponse = (account) => ({ ...account.toJSON(), roles: effectiveRoles(account) });

// ── Token issuance (access JWT + rotating refresh family in a cookie) ─────────
const generateAccessToken = (account) => {
  return jwt.sign(
    { id: account._id, roles: effectiveRoles(account), tv: account.tokenVersion || 0 },
    env.jwtSecret,
    { algorithm: 'HS256', expiresIn: env.accessTokenExpiresIn }
  );
};

const FAMILY_LEN = 32;
const SECRET_LEN = 64;
const generateRefreshTokenParts = () => ({
  family: crypto.randomBytes(16).toString('hex'),
  secret: crypto.randomBytes(32).toString('hex'),
});
const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
const parseRefreshToken = (token) => {
  if (!token || typeof token !== 'string') return null;
  if (token.length !== FAMILY_LEN + 1 + SECRET_LEN) return null;
  if (token[FAMILY_LEN] !== '.') return null;
  const family = token.slice(0, FAMILY_LEN);
  const secret = token.slice(FAMILY_LEN + 1);
  if (!/^[a-f0-9]+$/.test(family) || !/^[a-f0-9]+$/.test(secret)) return null;
  return { family, secret };
};
const refreshCookieOptions = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
const issueTokens = async (account, res) => {
  const { family, secret } = generateRefreshTokenParts();
  account.refreshTokenFamily = family;
  account.refreshTokenHash = hashSecret(secret);
  await account.save();
  res.cookie('refreshToken', `${family}.${secret}`, refreshCookieOptions);
  return generateAccessToken(account);
};
const rotateRefreshSecret = async (account, res) => {
  const { secret } = generateRefreshTokenParts();
  account.refreshTokenHash = hashSecret(secret);
  await account.save();
  res.cookie('refreshToken', `${account.refreshTokenFamily}.${secret}`, refreshCookieOptions);
  return generateAccessToken(account);
};

// ── Routes ────────────────────────────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password, displayName } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }
    const existing = await Account.findOne({
      $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
    });
    if (existing) {
      return res.status(400).json({ error: 'Registration failed. Please check your details and try again.' });
    }
    // Super-admin is granted by email via ADMIN_EMAILS (env), resolved at token
    // issuance — so every account is stored as a plain 'user' here.
    const account = new Account({
      username,
      email,
      password,
      displayName: displayName || '',
      roles: ['user'],
      ageConsent: true,
    });
    const accessToken = await issueTokens(account, res);
    sendVerifyEmail(account).catch((e) => console.error('Verify-email send failed (non-fatal):', e.message));
    res.status(201).json({ token: accessToken, user: userResponse(account) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(error.errors).map((e) => e.message).join(', ') });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const account = await Account.findOne({
      $or: [{ username: username.toLowerCase() }, { email: username.toLowerCase() }],
    });
    // Always run bcrypt to avoid user-enumeration timing. A passwordless (invited)
    // account compares against the dummy hash ⇒ password login fails (use the link).
    const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const isMatch = await bcrypt.compare(password, account && account.password ? account.password : DUMMY_HASH);
    if (!account || !isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    const accessToken = await issueTokens(account, res);
    res.json({ token: accessToken, user: userResponse(account) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/refresh', refreshLimiter, async (req, res) => {
  const parsed = parseRefreshToken(req.cookies?.refreshToken);
  if (!parsed) {
    res.clearCookie('refreshToken', refreshCookieOptions);
    return res.status(401).json({ error: 'No refresh token' });
  }
  try {
    const account = await Account.findOne({ refreshTokenFamily: parsed.family });
    if (!account) {
      res.clearCookie('refreshToken', refreshCookieOptions);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    // Replay detection: family matches but secret hash does not ⇒ revoke family.
    if (hashSecret(parsed.secret) !== account.refreshTokenHash) {
      account.refreshTokenFamily = null;
      account.refreshTokenHash = null;
      await account.save();
      res.clearCookie('refreshToken', refreshCookieOptions);
      console.warn('[security] refresh-token replay detected, family revoked', { accountId: String(account._id) });
      return res.status(401).json({ error: 'Token compromised — please log in again' });
    }
    const accessToken = await rotateRefreshSecret(account, res);
    res.json({ token: accessToken });
  } catch (error) {
    console.error('Refresh error:', error.message);
    res.clearCookie('refreshToken', refreshCookieOptions);
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

router.post('/logout', refreshLimiter, async (req, res) => {
  const parsed = parseRefreshToken(req.cookies?.refreshToken);
  try {
    if (parsed) {
      const account = await Account.findOne({ refreshTokenFamily: parsed.family });
      if (account) {
        account.refreshTokenFamily = null;
        account.refreshTokenHash = null;
        await account.save();
      }
    }
    res.clearCookie('refreshToken', refreshCookieOptions);
    res.json({ message: 'Logged out' });
  } catch (error) {
    res.clearCookie('refreshToken', refreshCookieOptions);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// POST /api/auth/logout-all — sign out every device: bump tokenVersion (kills all
// outstanding access tokens) and drop the refresh family (kills all refresh
// tokens). Use after a suspected compromise.
router.post('/logout-all', requireAuth, async (req, res) => {
  try {
    const account = await Account.findById(req.user.id);
    if (account) {
      account.tokenVersion = (account.tokenVersion || 0) + 1;
      account.refreshTokenHash = null;
      account.refreshTokenFamily = null;
      await account.save();
    }
    res.clearCookie('refreshToken', refreshCookieOptions);
    res.json({ message: 'Signed out on all devices.' });
  } catch (error) {
    res.status(500).json({ error: 'Could not sign out everywhere.' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const account = await Account.findById(req.user.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({ user: userResponse(account) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get account' });
  }
});

router.post('/verify-email', authLimiter, async (req, res) => {
  try {
    const doc = await consumeEmailToken({ token: req.body.token, kind: 'verify-email' });
    if (!doc) return res.status(400).json({ error: 'The link is invalid or has expired.' });
    await Account.updateOne({ _id: doc.account }, { $set: { emailVerified: true, emailVerifiedAt: new Date() } });
    res.json({ message: 'Email verified' });
  } catch (err) {
    res.status(500).json({ error: 'Verify failed' });
  }
});

router.post('/forgot-password', emailLimiter, async (req, res) => {
  const ack = { message: 'If the account exists, a reset link is on its way.' };
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      await noopJitter();
      return res.json(ack);
    }
    const account = await Account.findOne({ email: email.toLowerCase().trim() });
    if (account && emailService.isEnabled()) {
      await Token.deleteMany({ account: account._id, kind: 'reset-password', usedAt: null });
      try {
        await sendResetPasswordEmail(account);
      } catch (e) {
        console.error('Reset-password mail failed:', e.message);
      }
    } else {
      await noopJitter();
    }
    res.json(ack);
  } catch (err) {
    res.json(ack);
  }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password required.' });
    const doc = await consumeEmailToken({ token, kind: 'reset-password' });
    if (!doc) return res.status(400).json({ error: 'The link is invalid or has expired.' });
    const account = await Account.findById(doc.account);
    if (!account) return res.status(400).json({ error: 'Account not found.' });
    account.password = password;
    account.refreshTokenHash = null;
    account.refreshTokenFamily = null;
    account.tokenVersion = (account.tokenVersion || 0) + 1; // revoke outstanding access tokens
    if (!account.emailVerified) {
      account.emailVerified = true;
      account.emailVerifiedAt = new Date();
    }
    await account.save();
    res.json({ message: 'Password updated. Log in with the new one.' });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(error.errors).map((e) => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// ── Magic links (passwordless login + invites) ────────────────────────────────

// POST /api/auth/magic-link — body { email }. Email a returning player a login
// link. Anti-enumeration: always 200.
router.post('/magic-link', emailLimiter, async (req, res) => {
  const ack = { message: 'If the account exists, a login link is on its way.' };
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') { await noopJitter(); return res.json(ack); }
    const account = await Account.findOne({ email: email.toLowerCase().trim() });
    if (account && emailService.isEnabled()) {
      const raw = await magicLink.createMagicLink({ accountId: account._id });
      try {
        await emailService.send({
          to: account.email,
          subject: `Your login link — ${env.appName}`,
          html: emailService.wrapTemplate({
            title: `Log in to ${env.appName}`,
            intro: 'Tap to log in. This link is valid for 15 minutes and works once.',
            ctaUrl: magicLink.magicLinkUrl(raw),
            ctaLabel: 'Log in',
          }),
          text: `Log in: ${magicLink.magicLinkUrl(raw)}`,
        });
      } catch (e) { console.error('Magic-link mail failed:', e.message); }
    } else {
      await noopJitter();
    }
    res.json(ack);
  } catch (err) {
    res.json(ack);
  }
});

// POST /api/auth/magic-link/consume — body { token }. Logs in (issues tokens) and
// returns the eventId the link was for (so the SPA lands the player in it).
router.post('/magic-link/consume', authLimiter, async (req, res) => {
  try {
    const doc = await magicLink.consumeMagicLink(req.body?.token);
    if (!doc) return res.status(400).json({ error: 'The link is invalid or has expired.' });
    const account = await Account.findById(doc.account);
    if (!account) return res.status(400).json({ error: 'Account not found.' });
    // NB: do NOT mark the email verified here. An invite magic link is created
    // from an address the host typed (and is shareable out-of-band), so clicking
    // it doesn't prove the user controls that mailbox. Verification is granted
    // only by the dedicated verify-email link sent to the address itself.
    const accessToken = await issueTokens(account, res);
    res.json({
      token: accessToken,
      user: userResponse(account),
      eventId: doc.eventId ? String(doc.eventId) : null,
    });
  } catch (err) {
    console.error('Magic-link consume error:', err.message);
    res.status(500).json({ error: 'Could not log in with that link.' });
  }
});

// POST /api/auth/set-password — turn a (possibly passwordless, invited) account
// into a normal one by setting a password (+ optional username). requireAuth.
router.post('/set-password', requireAuth, authLimiter, async (req, res) => {
  try {
    const { password, username, currentPassword } = req.body || {};
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password required.' });
    const account = await Account.findById(req.user.id);
    if (!account) return res.status(404).json({ error: 'Account not found.' });
    // Setting a password on a passwordless (just-invited) account is a one-time
    // claim. But once an account HAS a password, changing it — or the username —
    // requires proving knowledge of the current one, so a leaked/stolen access
    // token (or an intercepted invite link to an already-claimed account) can't
    // silently rebind the identity.
    if (account.hasPassword() && !(currentPassword && (await account.comparePassword(currentPassword)))) {
      return res.status(403).json({ error: 'Enter your current password to change it.' });
    }
    if (username && typeof username === 'string') {
      const desired = username.toLowerCase().trim();
      if (desired && desired !== account.username) {
        const taken = await Account.exists({ username: desired, _id: { $ne: account._id } });
        if (taken) return res.status(409).json({ error: 'That username is taken.' });
        account.username = desired;
      }
    }
    account.password = password; // validated + hashed by the pre-save hook
    await account.save();
    res.json({ message: 'Account secured — you can now log in with a password.', user: userResponse(account) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(error.errors).map((e) => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Could not set the password.' });
  }
});

module.exports = router;
