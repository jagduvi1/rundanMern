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

// ── Token issuance (access JWT + rotating refresh family in a cookie) ─────────
const generateAccessToken = (account) => {
  const roles = account.roles && account.roles.length > 0 ? account.roles : ['user'];
  return jwt.sign({ id: account._id, roles }, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: env.accessTokenExpiresIn,
  });
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
    // The very first account bootstraps the deployment as super-admin.
    const isFirst = (await Account.estimatedDocumentCount()) === 0;
    const account = new Account({
      username,
      email,
      password,
      displayName: displayName || '',
      roles: isFirst ? ['user', 'admin'] : ['user'],
      ageConsent: true,
    });
    const accessToken = await issueTokens(account, res);
    sendVerifyEmail(account).catch((e) => console.error('Verify-email send failed (non-fatal):', e.message));
    res.status(201).json({ token: accessToken, user: account.toJSON() });
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
    // Always run bcrypt to avoid user-enumeration timing.
    const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const isMatch = await bcrypt.compare(password, account ? account.password : DUMMY_HASH);
    if (!account || !isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    const accessToken = await issueTokens(account, res);
    res.json({ token: accessToken, user: account.toJSON() });
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

router.get('/me', requireAuth, async (req, res) => {
  try {
    const account = await Account.findById(req.user.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({ user: account.toJSON() });
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

module.exports = router;
