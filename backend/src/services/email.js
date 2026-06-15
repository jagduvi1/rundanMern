const env = require('../config/env');

// Transactional email (host verify / reset / magic-link), via Resend. Entirely
// optional — when RESEND_API_KEY is unset, isEnabled() is false and the auth
// routes simply skip sending (username+password still works).
let client = null;

function isEnabled() {
  return env.hasEmail;
}

function getClient() {
  if (!client && env.resendApiKey) {
    try {
      // eslint-disable-next-line global-require
      const { Resend } = require('resend');
      client = new Resend(env.resendApiKey);
    } catch {
      client = null;
    }
  }
  return client;
}

async function send({ to, subject, html, text }) {
  if (!isEnabled()) throw new Error('Email service not configured');
  const c = getClient();
  if (!c) throw new Error('Email client unavailable');

  // Resend takes the From as a full "Name <addr@domain>" string and returns
  // { data, error } — it does NOT throw on API errors, so surface `error`
  // ourselves (e.g. an unverified sending domain) for the callers' logs.
  const { data, error } = await c.emails.send({
    from: env.emailFrom || `${env.appName} <noreply@example.com>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  });
  if (error) {
    const detail = typeof error === 'object' ? JSON.stringify(error) : String(error);
    throw new Error(`Resend send failed: ${detail}`);
  }
  return data;
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
