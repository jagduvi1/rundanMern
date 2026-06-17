const env = require('../config/env');

// Transactional email (host verify / reset / magic-link), via Mailgun. Entirely
// optional — when MAILGUN_API_KEY / MAILGUN_DOMAIN are unset, isEnabled() is
// false and the auth routes simply skip sending (username+password still works).
// Uses the built-in fetch (Node 18+), so there is no SDK dependency.

function isEnabled() {
  return env.hasEmail;
}

async function send({ to, subject, html, text }) {
  if (!isEnabled()) throw new Error('Email service not configured');

  // Mailgun messages API: POST {base}/v3/{domain}/messages, HTTP Basic auth
  // "api:<key>", form-encoded. Region base is api.mailgun.net (US) or
  // api.eu.mailgun.net (EU). Returns 2xx with { id, message }; on failure the
  // body carries the reason (e.g. an unverified/mismatched sending domain).
  const url = `${env.mailgunApiBase}/v3/${env.mailgunDomain}/messages`;
  const form = new URLSearchParams();
  form.set('from', env.emailFrom || `${env.appName} <noreply@${env.mailgunDomain}>`);
  form.set('to', Array.isArray(to) ? to.join(', ') : to);
  form.set('subject', subject);
  if (text) form.set('text', text);
  if (html) form.set('html', html);

  const auth = Buffer.from(`api:${env.mailgunApiKey}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Mailgun send failed (${res.status}): ${body}`);
  }
  try {
    return JSON.parse(body); // { id, message }
  } catch {
    return { raw: body };
  }
}

// HTML-escape host-controlled text (event names, display names) and only allow
// http(s) CTA URLs — these strings are interpolated into HTML emails sent from the
// trusted sender domain, so unescaped input would be HTML/link injection.
const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeHttpUrl = (u) => (/^https?:\/\//i.test(String(u ?? '').trim()) ? String(u).trim() : '');

function wrapTemplate({ title, intro, ctaUrl, ctaLabel, footer }) {
  const t = escapeHtml(title);
  const i = escapeHtml(intro);
  const label = escapeHtml(ctaLabel || 'Open');
  const url = safeHttpUrl(ctaUrl);
  const f = footer ? escapeHtml(footer) : '';
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
<h1 style="font-size:20px">${t}</h1>
<p style="line-height:1.5">${i}</p>
${url ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${label}</a></p>` : ''}
${f ? `<p style="color:#777;font-size:12px;margin-top:24px">${f}</p>` : ''}
</body></html>`;
}

module.exports = { isEnabled, send, wrapTemplate };
