const env = require('../config/env');

// Transactional email (host verify / reset / magic-link), via MailerSend.
// Entirely optional — when MAILERSEND_API_KEY is unset, isEnabled() is false and
// the auth routes simply skip sending (username+password still works). Mirrors
// Glosan's email service interface.
let client = null;

function isEnabled() {
  return env.hasEmail;
}

function getClient() {
  if (!client && env.mailerSendApiKey) {
    try {
      // eslint-disable-next-line global-require
      const { MailerSend } = require('mailersend');
      client = new MailerSend({ apiKey: env.mailerSendApiKey });
    } catch {
      client = null;
    }
  }
  return client;
}

// Parse an EMAIL_FROM value of the form "Name <addr@domain>" or "addr@domain"
// into the { email, name } pair the MailerSend Sender expects.
function parseFrom(raw) {
  const value = (raw || 'Rundan <noreply@example.com>').trim();
  const m = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || env.appName, email: m[2].trim() };
  return { name: env.appName, email: value };
}

async function send({ to, subject, html, text }) {
  if (!isEnabled()) throw new Error('Email service not configured');
  const c = getClient();
  if (!c) throw new Error('Email client unavailable');

  // eslint-disable-next-line global-require
  const { EmailParams, Sender, Recipient } = require('mailersend');
  const from = parseFrom(env.emailFrom);
  const recipients = (Array.isArray(to) ? to : [to]).map((addr) => new Recipient(addr));

  const params = new EmailParams()
    .setFrom(new Sender(from.email, from.name))
    .setTo(recipients)
    .setSubject(subject);
  if (html) params.setHtml(html);
  if (text) params.setText(text);

  try {
    return await c.email.send(params);
  } catch (err) {
    // The MailerSend SDK throws a response-like object with no `.message`, so
    // callers logged `undefined`. Surface the status + API body so the real
    // reason shows up — e.g. a trial-mode account that may only send to the
    // account owner's own address until it's approved.
    const status = err?.statusCode ?? err?.response?.statusCode ?? '';
    const rawBody = err?.body ?? err?.response?.body ?? err?.message;
    const detail = rawBody && typeof rawBody === 'object'
      ? JSON.stringify(rawBody)
      : String(rawBody ?? 'unknown error');
    throw new Error(`MailerSend send failed (${status}): ${detail}`);
  }
}

function wrapTemplate({ title, intro, ctaUrl, ctaLabel, footer }) {
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
<h1 style="font-size:20px">${title}</h1>
<p style="line-height:1.5">${intro}</p>
${ctaUrl ? `<p><a href="${ctaUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${ctaLabel || 'Open'}</a></p>` : ''}
${footer ? `<p style="color:#777;font-size:12px;margin-top:24px">${footer}</p>` : ''}
</body></html>`;
}

module.exports = { isEnabled, send, wrapTemplate };
