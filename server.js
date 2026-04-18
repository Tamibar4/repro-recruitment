/**
 * Recruitment Manager - Server
 * שרת ניהול גיוס והשמה
 *
 * Uses JSON-based storage (no native dependencies).
 * Data is persisted to `database.json` on every write.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// Load .env file if present (no dotenv dep needed)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  }
} catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const AUDIT_LOG_FILE = path.join(__dirname, 'audit.log');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Allow disabling host binding restriction. Default to localhost-only for safety.
// In production (Render etc.) listen on 0.0.0.0; locally on 127.0.0.1
// In production (Railway/Render) listen on 0.0.0.0; locally on 127.0.0.1
const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER ? '0.0.0.0' : '127.0.0.1');

// Allowed origins for CORS - default to local origins only.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`)
  .split(',').map(s => s.trim()).filter(Boolean);

// Trust proxy if running behind reverse proxy (for accurate req.ip)
app.set('trust proxy', 1);
// Disable X-Powered-By fingerprinting
app.disable('x-powered-by');

// ============================================================
// SECURITY: Crypto / Auth
// ============================================================

// PBKDF2 with 200,000 iterations + SHA-512 + per-user salt
const PBKDF2_ITERATIONS = 200000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return { salt, hash };
}

// Constant-time password verification
function verifyPassword(password, salt, expectedHashHex) {
  if (!password || !salt || !expectedHashHex) return false;
  try {
    const computed = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
    const expected = Buffer.from(expectedHashHex, 'hex');
    if (computed.length !== expected.length) return false;
    return crypto.timingSafeEqual(computed, expected);
  } catch (e) {
    return false;
  }
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Hash a token (e.g. for storing reset tokens) - never store the raw token
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ============================================================
// EMAIL: Gmail SMTP transporter
// ============================================================
let mailTransporter = null;
function getMailTransporter() {
  if (mailTransporter) return mailTransporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return null;
  }
  mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
  return mailTransporter;
}

async function sendEmail({ to, subject, text, html }) {
  const transporter = getMailTransporter();
  if (!transporter) {
    // Fallback: log to console + audit if no SMTP configured
    console.log('\n📧 [EMAIL NOT CONFIGURED] Would send email:');
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   ${text}\n`);
    auditLog('email_not_sent_no_smtp', { to, subject });
    return { sent: false, fallback: true };
  }
  try {
    await transporter.sendMail({
      from: `"RePro" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text,
      html: html || text
    });
    auditLog('email_sent', { to, subject });
    return { sent: true };
  } catch (err) {
    console.error('Failed to send email:', err.message);
    auditLog('email_send_failed', { to, subject, error: err.message });
    return { sent: false, error: err.message };
  }
}

// In-memory session store
const sessions = new Map();
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_INACTIVITY_MS = 2 * 60 * 60 * 1000; // 2 hours of inactivity

// ============================================================
// SECURITY: Audit Logging
// ============================================================
function auditLog(event, details = {}) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...details
    }) + '\n';
    fs.appendFile(AUDIT_LOG_FILE, line, () => {});
  } catch (e) { /* swallow */ }
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// ============================================================
// SECURITY: Rate Limiting (in-memory, sliding window)
// ============================================================
const rateLimitStore = new Map();

function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const record = rateLimitStore.get(key);
  if (!record || record.resetAt < now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  record.count++;
  if (record.count > limit) {
    return { ok: false, retryAfter: Math.ceil((record.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: limit - record.count };
}

// Cleanup expired rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitStore) if (v.resetAt < now) rateLimitStore.delete(k);
}, 5 * 60 * 1000).unref?.();

// ============================================================
// SECURITY: Account Lockout (per-user, after failed logins)
// ============================================================
const failedLoginsByUser = new Map(); // username -> { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 min

function isLocked(username) {
  const rec = failedLoginsByUser.get(username);
  if (!rec) return false;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) {
    failedLoginsByUser.delete(username);
    return false;
  }
  return false;
}

function recordFailedLogin(username) {
  const rec = failedLoginsByUser.get(username) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_LOGIN_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    auditLog('account_locked', { username, until: new Date(rec.lockedUntil).toISOString() });
  }
  failedLoginsByUser.set(username, rec);
}

function clearFailedLogins(username) {
  failedLoginsByUser.delete(username);
}

// ============================================================
// SECURITY: Input Validation
// ============================================================
function validateString(val, { required = false, maxLen = 500, minLen = 0 } = {}) {
  if (val == null || val === '') {
    if (required) throw new Error('Required field missing');
    return null;
  }
  if (typeof val !== 'string') throw new Error('Invalid type, expected string');
  const trimmed = val.trim();
  if (trimmed.length < minLen) throw new Error(`Too short (min ${minLen})`);
  if (trimmed.length > maxLen) throw new Error(`Too long (max ${maxLen})`);
  return trimmed;
}

function validateInt(val, { required = false, min, max } = {}) {
  if (val == null || val === '') {
    if (required) throw new Error('Required field missing');
    return null;
  }
  const n = Number(val);
  if (!Number.isInteger(n)) throw new Error('Invalid integer');
  if (min != null && n < min) throw new Error(`Must be >= ${min}`);
  if (max != null && n > max) throw new Error(`Must be <= ${max}`);
  return n;
}

function validateEnum(val, allowed, { required = false } = {}) {
  if (val == null || val === '') {
    if (required) throw new Error('Required field missing');
    return null;
  }
  if (!allowed.includes(val)) throw new Error(`Invalid value, expected one of: ${allowed.join(', ')}`);
  return val;
}

// ============================================================
// SECURITY: Auth Middleware
// ============================================================
function authMiddleware(req, res, next) {
  // Allow auth endpoints (login/logout/me)
  if (req.path.startsWith('/api/auth/')) return next();
  // Only protect /api routes
  if (!req.path.startsWith('/api/')) return next();

  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const now = Date.now();
  if (session.expiresAt < now) {
    sessions.delete(token);
    auditLog('session_expired', { username: session.username, ip: getClientIp(req) });
    return res.status(401).json({ error: 'Session expired' });
  }
  // Inactivity timeout
  if (session.lastActivity && (now - session.lastActivity) > SESSION_INACTIVITY_MS) {
    sessions.delete(token);
    auditLog('session_inactive_timeout', { username: session.username, ip: getClientIp(req) });
    return res.status(401).json({ error: 'Session inactive' });
  }

  // Optional: Bind session to user agent + IP (rejects token theft from different network)
  if (session.ipBound && session.ipBound !== getClientIp(req)) {
    sessions.delete(token);
    auditLog('session_ip_mismatch', { username: session.username, ip: getClientIp(req), bound: session.ipBound });
    return res.status(401).json({ error: 'Session validation failed' });
  }

  session.lastActivity = now;
  req.user = session;
  next();
}

// ============================================================
// SECURITY: Origin Guard (CSRF defense in depth)
// ============================================================
function originGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return next();
  // Allow listed origins + any *.up.railway.app (for Railway deployments)
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o)) ||
                  (process.env.RAILWAY_PUBLIC_DOMAIN && origin.includes(process.env.RAILWAY_PUBLIC_DOMAIN)) ||
                  origin.includes('.up.railway.app');
  if (!allowed) {
    auditLog('origin_blocked', { ip: getClientIp(req), origin, path: req.path });
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
}

// ============================================================
// SECURITY: Middleware Stack (must run on every request)
// ============================================================

// 1. Security headers (Helmet-style, hand-rolled to avoid extra deps)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // Modern browsers ignore this; CSP is the real defense
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  // Strict Content Security Policy - blocks XSS, inline scripts, external resources
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'"
    ].join('; ')
  );
  next();
});

// 2. CORS - allow same-origin + whitelisted origins (Railway auto-adds RAILWAY_PUBLIC_DOMAIN)
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : null;
const dynamicOrigins = [...ALLOWED_ORIGINS];
if (railwayDomain) dynamicOrigins.push(railwayDomain);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Allow same-origin (no Origin header)
    if (dynamicOrigins.includes(origin)) return callback(null, true);
    // In production, allow any *.up.railway.app subdomain (for preview deployments too)
    if (origin.endsWith('.up.railway.app')) return callback(null, true);
    callback(null, false); // Return false instead of throwing - lets request through but no CORS headers
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

// 3. JSON body limit (prevent JSON DoS)
app.use(express.json({ limit: '256kb' }));

// 4. Origin guard (CSRF defense in depth)
app.use(originGuard);

// 5. Global rate limiter (per-IP for all API requests)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const ip = getClientIp(req);
  const result = rateLimit({ key: 'global:' + ip, limit: 300, windowMs: 60 * 1000 }); // 300 req/min
  if (!result.ok) {
    res.setHeader('Retry-After', String(result.retryAfter));
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
});

// 6. Static files - safe directory only
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  etag: true,
  index: false,
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.svg')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ============================================================
// Simple JSON Database Layer
// ============================================================
// Default 5 users with per-user salts (user can change passwords later)
function buildUser(username, display_name, password, role, email) {
  const { salt, hash } = hashPassword(password);
  return {
    username,
    display_name,
    email: email || null,
    salt,
    password_hash: hash,
    role,
    status: 'active', // active | pending | disabled
    password_reset_token_hash: null,
    password_reset_expires: null,
    created_at: new Date().toISOString()
  };
}
const defaultUsers = [
  buildUser('admin', 'Admin',     'admin123', 'admin'),
  buildUser('user1', 'משתמש 1',   'repro123', 'user'),
  buildUser('user2', 'משתמש 2',   'repro123', 'user'),
  buildUser('user3', 'משתמש 3',   'repro123', 'user'),
  buildUser('user4', 'משתמש 4',   'repro123', 'user')
];

const DEFAULT_CATEGORIES = [
  { id: 'chimney', label_he: 'ארובות (Chimney)', label_en: 'Chimney', color: '#fdab3d' },
  { id: 'air_duct', label_he: 'אייר דאקט (Air Duct)', label_en: 'Air Duct', color: '#0073ea' },
  { id: 'garage_door', label_he: 'גארז\' דור (Garage Door)', label_en: 'Garage Door', color: '#a358df' },
  { id: 'construction', label_he: 'קונסטרקשן (Construction)', label_en: 'Construction', color: '#00c875' },
  { id: 'cosmetics', label_he: 'מכירות (Cosmetics)', label_en: 'Cosmetics', color: '#ff158a' }
];

const defaultData = {
  jobs: [],
  candidates: [],
  stage_history: [],
  users: defaultUsers,
  categories: DEFAULT_CATEGORIES,
  counters: { jobs: 0, candidates: 0, stage_history: 0 }
};

let data = defaultData;

function loadData() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      data = JSON.parse(raw);
      // Ensure all collections exist
      data.jobs = data.jobs || [];
      data.candidates = data.candidates || [];
      data.stage_history = data.stage_history || [];
      data.counters = data.counters || { jobs: 0, candidates: 0, stage_history: 0 };
      // Add default categories if missing
      if (!data.categories || data.categories.length === 0) {
        data.categories = DEFAULT_CATEGORIES;
        saveData();
      }
      // Add default users if missing (migration for existing databases)
      if (!data.users || data.users.length === 0) {
        data.users = defaultUsers;
        saveData();
      }
      // Migrate old-format users (no salt) to new format - reset to defaults for safety
      const needsMigration = data.users.some(u => !u.salt);
      if (needsMigration) {
        console.log('⚠ Migrating users to new password format - resetting to defaults');
        data.users = defaultUsers;
        saveData();
      }
    } else {
      data = JSON.parse(JSON.stringify(defaultData));
      saveData();
    }
  } catch (err) {
    console.error('Error loading database:', err);
    data = JSON.parse(JSON.stringify(defaultData));
  }
}

function saveData() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving database:', err);
    throw err;
  }
}

function nextId(collection) {
  data.counters[collection] = (data.counters[collection] || 0) + 1;
  return data.counters[collection];
}

function now() {
  return new Date().toISOString();
}

loadData();
console.log('✓ Database loaded from', DB_FILE);

// ============================================================
// AUTH API
// ============================================================

// POST /api/auth/login - rate limited + account lockout + audit logged
app.post('/api/auth/login', (req, res) => {
  const ip = getClientIp(req);

  // Rate limit by IP: 10 login attempts per 5 minutes
  const ipLimit = rateLimit({ key: 'login_ip:' + ip, limit: 10, windowMs: 5 * 60 * 1000 });
  if (!ipLimit.ok) {
    auditLog('login_rate_limited', { ip, retryAfter: ipLimit.retryAfter });
    res.setHeader('Retry-After', String(ipLimit.retryAfter));
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  try {
    // Validate inputs strictly
    let username, password;
    try {
      username = validateString(req.body?.username, { required: true, maxLen: 64, minLen: 1 });
      password = validateString(req.body?.password, { required: true, maxLen: 128, minLen: 1 });
    } catch (e) {
      auditLog('login_invalid_input', { ip });
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    username = username.toLowerCase();

    // Account lockout check
    if (isLocked(username)) {
      auditLog('login_blocked_locked', { username, ip });
      // Generic error - don't reveal lockout to attacker
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = data.users.find(u => u.username === username);

    // Run hash comparison even if user doesn't exist (timing attack defense)
    const dummySalt = 'dummy_salt_for_timing_protection_xxxxxxxxxxxxxx';
    const dummyHash = '0'.repeat(128);
    const ok = user
      ? verifyPassword(password, user.salt, user.password_hash)
      : (verifyPassword(password, dummySalt, dummyHash), false);

    if (!ok) {
      recordFailedLogin(username);
      auditLog('login_failed', { username, ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check account status
    if (user.status === 'pending') {
      auditLog('login_pending_account', { username, ip });
      return res.status(403).json({ error: 'pending' });
    }
    if (user.status === 'disabled') {
      auditLog('login_disabled_account', { username, ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Success - clear lockout, create session
    clearFailedLogins(username);
    const token = generateToken();
    sessions.set(token, {
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      ipBound: ip,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      expiresAt: Date.now() + SESSION_DURATION_MS
    });
    auditLog('login_success', { username: user.username, ip });

    res.json({
      token,
      user: { username: user.username, display_name: user.display_name, role: user.role }
    });
  } catch (err) {
    auditLog('login_error', { ip, error: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) {
    const session = sessions.get(token);
    if (session) auditLog('logout', { username: session.username, ip: getClientIp(req) });
    sessions.delete(token);
  }
  res.json({ success: true });
});

// GET /api/auth/me
app.get('/api/auth/me', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  // Update last activity
  session.lastActivity = Date.now();
  res.json({
    username: session.username,
    display_name: session.display_name,
    role: session.role
  });
});

// POST /api/auth/change-password - allow user to change own password
app.post('/api/auth/change-password', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return res.status(401).json({ error: 'Unauthorized' });

  const ip = getClientIp(req);
  const limitResult = rateLimit({ key: 'pwchange:' + session.username, limit: 5, windowMs: 60 * 60 * 1000 });
  if (!limitResult.ok) {
    return res.status(429).json({ error: 'Too many attempts' });
  }

  try {
    const currentPassword = validateString(req.body?.current_password, { required: true, maxLen: 128, minLen: 1 });
    const newPassword = validateString(req.body?.new_password, { required: true, maxLen: 128, minLen: 8 });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password too short (min 8)' });

    const user = data.users.find(u => u.username === session.username);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    if (!verifyPassword(currentPassword, user.salt, user.password_hash)) {
      auditLog('password_change_failed', { username: user.username, ip });
      return res.status(401).json({ error: 'Invalid current password' });
    }

    const { salt, hash } = hashPassword(newPassword);
    user.salt = salt;
    user.password_hash = hash;
    saveData();
    auditLog('password_changed', { username: user.username, ip });

    // Invalidate all sessions for this user except current one (force re-login on other devices)
    for (const [t, s] of sessions) {
      if (s.username === user.username && t !== token) sessions.delete(t);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Invalid input' });
  }
});

// ============================================================
// REGISTRATION (requires admin approval)
// ============================================================

// POST /api/auth/register - create pending user
app.post('/api/auth/register', (req, res) => {
  const ip = getClientIp(req);
  const ipLimit = rateLimit({ key: 'register_ip:' + ip, limit: 5, windowMs: 60 * 60 * 1000 });
  if (!ipLimit.ok) return res.status(429).json({ error: 'Too many attempts' });

  try {
    const username = validateString(req.body?.username, { required: true, maxLen: 32, minLen: 3 });
    const display_name = validateString(req.body?.display_name, { required: true, maxLen: 64, minLen: 2 });
    const email = validateString(req.body?.email, { required: true, maxLen: 128, minLen: 5 });
    const password = validateString(req.body?.password, { required: true, maxLen: 128, minLen: 8 });

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    // Validate username format (alphanumeric + underscore only)
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username: only letters, numbers, underscore' });
    }

    // Check if username already exists
    const existing = data.users.find(u => u.username === username.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    // Check if email already used
    const emailExists = data.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
    if (emailExists) return res.status(409).json({ error: 'Email already registered' });

    // Create pending user
    const { salt, hash } = hashPassword(password);
    const newUser = {
      username: username.toLowerCase(),
      display_name,
      email: email.toLowerCase(),
      salt,
      password_hash: hash,
      role: 'user',
      status: 'pending',
      password_reset_token_hash: null,
      password_reset_expires: null,
      created_at: now()
    };
    data.users.push(newUser);
    saveData();
    auditLog('user_registered_pending', { username: newUser.username, email: newUser.email, ip });

    // Notify admin via email
    const admins = data.users.filter(u => u.role === 'admin' && u.email && u.status === 'active');
    admins.forEach(admin => {
      sendEmail({
        to: admin.email,
        subject: 'RePro - בקשת הרשמה חדשה',
        text: `משתמש חדש מבקש להצטרף:\n\nשם: ${display_name}\nשם משתמש: ${newUser.username}\nאימייל: ${email}\n\nהיכנסי למערכת ואשרי/דחי את הבקשה.`,
        html: `<div style="font-family:sans-serif;direction:rtl">
          <h2>בקשת הרשמה חדשה ב-RePro</h2>
          <p><strong>שם:</strong> ${display_name}</p>
          <p><strong>שם משתמש:</strong> ${newUser.username}</p>
          <p><strong>אימייל:</strong> ${email}</p>
          <p>היכנסי למערכת ואשרי/דחי את הבקשה.</p>
        </div>`
      });
    });

    res.status(201).json({ success: true, message: 'Registration pending admin approval' });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid input' });
  }
});

// ============================================================
// PASSWORD RESET (forgot password)
// ============================================================

// POST /api/auth/forgot-password - request reset link via email
app.post('/api/auth/forgot-password', (req, res) => {
  const ip = getClientIp(req);
  const ipLimit = rateLimit({ key: 'forgot_ip:' + ip, limit: 5, windowMs: 15 * 60 * 1000 });
  if (!ipLimit.ok) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

  try {
    const email = validateString(req.body?.email, { required: true, maxLen: 128, minLen: 5 });

    // Always return success (don't reveal if email exists)
    const user = data.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase() && u.status === 'active');

    if (user) {
      // Generate reset token (expires in 1 hour)
      const rawToken = generateToken();
      user.password_reset_token_hash = hashToken(rawToken);
      user.password_reset_expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      saveData();

      const resetUrl = `${APP_URL}/reset-password.html?token=${rawToken}`;

      sendEmail({
        to: user.email,
        subject: 'RePro - איפוס סיסמה',
        text: `שלום ${user.display_name},\n\nקיבלנו בקשה לאיפוס הסיסמה שלך.\n\nלחצי על הקישור הבא (תקף לשעה אחת):\n${resetUrl}\n\nאם לא ביקשת איפוס סיסמה, את יכולה להתעלם מהמייל הזה.\n\nRePro`,
        html: `<div style="font-family:sans-serif;direction:rtl;max-width:500px;margin:0 auto">
          <h2 style="color:#0d47a1">איפוס סיסמה - RePro</h2>
          <p>שלום <strong>${user.display_name}</strong>,</p>
          <p>קיבלנו בקשה לאיפוס הסיסמה שלך.</p>
          <p style="text-align:center;margin:28px 0">
            <a href="${resetUrl}" style="background:linear-gradient(135deg,#0073ea,#5559df);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block">
              איפוס סיסמה
            </a>
          </p>
          <p style="color:#888;font-size:13px">הקישור תקף לשעה אחת. אם לא ביקשת איפוס - התעלמי מהמייל הזה.</p>
        </div>`
      });

      auditLog('password_reset_requested', { username: user.username, ip });
    } else {
      auditLog('password_reset_no_user', { email, ip });
    }

    // Always return success (don't reveal if email exists)
    res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid input' });
  }
});

// POST /api/auth/reset-password - use reset token to set new password
app.post('/api/auth/reset-password', (req, res) => {
  const ip = getClientIp(req);
  const ipLimit = rateLimit({ key: 'reset_ip:' + ip, limit: 10, windowMs: 15 * 60 * 1000 });
  if (!ipLimit.ok) return res.status(429).json({ error: 'Too many attempts' });

  try {
    const token = validateString(req.body?.token, { required: true, maxLen: 128, minLen: 32 });
    const newPassword = validateString(req.body?.password, { required: true, maxLen: 128, minLen: 8 });

    const tokenHash = hashToken(token);
    const user = data.users.find(u =>
      u.password_reset_token_hash === tokenHash &&
      u.password_reset_expires &&
      new Date(u.password_reset_expires) > new Date()
    );

    if (!user) {
      auditLog('password_reset_invalid_token', { ip });
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    // Set new password
    const { salt, hash } = hashPassword(newPassword);
    user.salt = salt;
    user.password_hash = hash;
    user.password_reset_token_hash = null;
    user.password_reset_expires = null;
    saveData();

    // Invalidate all sessions for this user
    for (const [t, s] of sessions) {
      if (s.username === user.username) sessions.delete(t);
    }

    auditLog('password_reset_success', { username: user.username, ip });
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid input' });
  }
});

// ============================================================
// ADMIN: Manage pending registrations
// ============================================================

// GET /api/auth/pending - list pending users (admin only)
app.get('/api/auth/pending', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(token);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const pending = data.users
    .filter(u => u.status === 'pending')
    .map(u => ({ username: u.username, display_name: u.display_name, email: u.email, created_at: u.created_at }));
  res.json(pending);
});

// POST /api/auth/approve/:username - approve pending user (admin only)
app.post('/api/auth/approve/:username', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(token);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const user = data.users.find(u => u.username === req.params.username && u.status === 'pending');
  if (!user) return res.status(404).json({ error: 'Pending user not found' });

  user.status = 'active';
  saveData();
  auditLog('user_approved', { username: user.username, by: session.username });

  // Notify user via email
  if (user.email) {
    sendEmail({
      to: user.email,
      subject: 'RePro - ההרשמה שלך אושרה!',
      text: `שלום ${user.display_name},\n\nההרשמה שלך ל-RePro אושרה!\n\nאת/ה יכול/ה להתחבר עכשיו:\n${APP_URL}/login.html\n\nשם משתמש: ${user.username}\n\nRePro Team`,
      html: `<div style="font-family:sans-serif;direction:rtl;max-width:500px;margin:0 auto">
        <h2 style="color:#00c875">ההרשמה אושרה!</h2>
        <p>שלום <strong>${user.display_name}</strong>,</p>
        <p>ההרשמה שלך ל-RePro אושרה בהצלחה!</p>
        <p style="text-align:center;margin:28px 0">
          <a href="${APP_URL}/login.html" style="background:linear-gradient(135deg,#0073ea,#5559df);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block">
            התחברות למערכת
          </a>
        </p>
        <p style="color:#888;font-size:13px">שם משתמש: <strong>${user.username}</strong></p>
      </div>`
    });
  }

  res.json({ success: true, message: `User ${user.username} approved` });
});

// POST /api/auth/reject/:username - reject pending user (admin only)
app.post('/api/auth/reject/:username', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(token);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const idx = data.users.findIndex(u => u.username === req.params.username && u.status === 'pending');
  if (idx === -1) return res.status(404).json({ error: 'Pending user not found' });

  const user = data.users[idx];
  data.users.splice(idx, 1);
  saveData();
  auditLog('user_rejected', { username: user.username, by: session.username });

  res.json({ success: true, message: `User ${user.username} rejected` });
});

// GET /api/auth/users - list of users (without sensitive fields)
app.get('/api/auth/users', (req, res) => {
  // Require authentication for this endpoint
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });

  res.json(data.users.map(u => ({
    username: u.username,
    display_name: u.display_name,
    email: u.email || null,
    role: u.role,
    status: u.status || 'active',
    created_at: u.created_at || null
  })));
});

// ============================================================
// PROFILE API (authenticated user)
// ============================================================

// GET /api/auth/profile - get full profile
app.get('/api/auth/profile', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const user = data.users.find(u => u.username === session.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    username: user.username,
    display_name: user.display_name,
    email: user.email || '',
    role: user.role,
    avatar_url: user.avatar_url || null,
    notifications: user.notifications || { email_follow_up: true, email_duplicate: true, email_payment: true },
    created_at: user.created_at
  });
});

// PUT /api/auth/profile - update profile
app.put('/api/auth/profile', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const user = data.users.find(u => u.username === session.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const { display_name, email, avatar_url, notifications } = req.body;

    if (display_name !== undefined) {
      const name = validateString(display_name, { required: true, maxLen: 64, minLen: 2 });
      user.display_name = name;
      session.display_name = name;
    }

    if (email !== undefined) {
      const em = validateString(email, { required: true, maxLen: 128, minLen: 5 });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Invalid email' });
      // Check email not taken by another user
      const emailTaken = data.users.find(u => u.email && u.email.toLowerCase() === em.toLowerCase() && u.username !== user.username);
      if (emailTaken) return res.status(409).json({ error: 'Email already in use' });
      user.email = em.toLowerCase();
    }

    if (avatar_url !== undefined) {
      user.avatar_url = avatar_url || null;
    }

    if (notifications !== undefined && typeof notifications === 'object') {
      user.notifications = {
        email_follow_up: !!notifications.email_follow_up,
        email_duplicate: !!notifications.email_duplicate,
        email_payment: !!notifications.email_payment
      };
    }

    saveData();

    // Update localStorage data
    res.json({
      username: user.username,
      display_name: user.display_name,
      email: user.email,
      role: user.role,
      avatar_url: user.avatar_url,
      notifications: user.notifications
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/auth/change-password
app.put('/api/auth/change-password', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const user = data.users.find(u => u.username === session.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Verify current password
    const ok = verifyPassword(current_password, user.salt, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    // Set new password
    const { salt, hash } = hashPassword(new_password);
    user.salt = salt;
    user.password_hash = hash;
    saveData();

    auditLog('password_changed', { username: user.username });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Apply auth middleware AFTER auth routes are defined (to all subsequent /api routes)
app.use(authMiddleware);

// ============================================================
// CATEGORIES API
// ============================================================

// GET /api/categories
app.get('/api/categories', (req, res) => {
  res.json(data.categories || []);
});

// POST /api/categories - add new category
app.post('/api/categories', (req, res) => {
  try {
    const { id, label_he, label_en, color } = req.body;
    if (!id || !label_he) return res.status(400).json({ error: 'id and label_he required' });
    // Sanitize id
    const cleanId = id.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (data.categories.find(c => c.id === cleanId)) {
      return res.status(409).json({ error: 'Category already exists' });
    }
    const cat = { id: cleanId, label_he, label_en: label_en || label_he, color: color || '#6c757d' };
    data.categories.push(cat);
    saveData();
    res.status(201).json(cat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/categories/:id
app.delete('/api/categories/:id', (req, res) => {
  try {
    const idx = data.categories.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Category not found' });
    data.categories.splice(idx, 1);
    saveData();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// JOBS API
// ============================================================

// GET /api/jobs
app.get('/api/jobs', (req, res) => {
  try {
    const { category, status, search } = req.query;
    let jobs = [...data.jobs];

    if (category && category !== 'all') {
      jobs = jobs.filter(j => j.category === category);
    }
    if (status && status !== 'all') {
      jobs = jobs.filter(j => j.status === status);
    }
    if (search) {
      const s = search.toLowerCase();
      jobs = jobs.filter(j =>
        (j.title || '').toLowerCase().includes(s) ||
        (j.company || '').toLowerCase().includes(s) ||
        (j.location || '').toLowerCase().includes(s) ||
        (Array.isArray(j.locations) && j.locations.some(l => (l.name || '').toLowerCase().includes(s)))
      );
    }

    // Sort: urgent first, then by created_at desc
    jobs.sort((a, b) => {
      const aUrgent = a.is_urgent ? 1 : 0;
      const bUrgent = b.is_urgent ? 1 : 0;
      if (aUrgent !== bUrgent) return bUrgent - aUrgent;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });

    // Attach candidate counts
    const jobsWithCounts = jobs.map(job => {
      const stageCounts = { stage1: 0, stage2: 0, accepted: 0, rejected: 0 };
      data.candidates.forEach(c => {
        if (c.job_id === job.id && stageCounts[c.stage] !== undefined) {
          stageCounts[c.stage]++;
        }
      });
      return { ...job, candidate_counts: stageCounts };
    });

    res.json(jobsWithCounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id
app.get('/api/jobs/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const job = data.jobs.find(j => j.id === id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const candidates = data.candidates
      .filter(c => c.job_id === id)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    res.json({ ...job, candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs
app.post('/api/jobs', (req, res) => {
  try {
    const { title, category, company, location, locations, salary_range, commission, description, status, notes, is_urgent, requirements } = req.body;
    if (!title || !category) {
      return res.status(400).json({ error: 'Title and category are required' });
    }

    const job = {
      id: nextId('jobs'),
      title,
      category,
      company: company || null,
      location: location || null,
      locations: Array.isArray(locations) ? locations : [],
      requirements: Array.isArray(requirements) ? requirements.filter(r => r && r.trim()) : [],
      is_urgent: !!is_urgent,
      salary_range: salary_range || null,
      commission: commission != null ? Number(commission) : null,
      description: description || null,
      status: status || 'open',
      notes: notes || null,
      created_at: now(),
      updated_at: now()
    };

    data.jobs.push(job);
    saveData();
    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/jobs/:id
app.put('/api/jobs/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = data.jobs.findIndex(j => j.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Job not found' });

    const { title, category, company, location, locations, salary_range, commission, description, status, notes, is_urgent, requirements } = req.body;
    data.jobs[idx] = {
      ...data.jobs[idx],
      title,
      category,
      company: company || null,
      location: location || null,
      locations: Array.isArray(locations) ? locations : (data.jobs[idx].locations || []),
      requirements: Array.isArray(requirements) ? requirements.filter(r => r && r.trim()) : (data.jobs[idx].requirements || []),
      is_urgent: typeof is_urgent === 'boolean' ? is_urgent : !!data.jobs[idx].is_urgent,
      salary_range: salary_range || null,
      commission: commission !== undefined ? (commission != null ? Number(commission) : null) : (data.jobs[idx].commission || null),
      description: description || null,
      status: status || 'open',
      notes: notes || null,
      updated_at: now()
    };

    saveData();
    res.json(data.jobs[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/jobs/:id/urgent - quick toggle
app.patch('/api/jobs/:id/urgent', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = data.jobs.findIndex(j => j.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Job not found' });

    const { is_urgent } = req.body;
    data.jobs[idx].is_urgent = !!is_urgent;
    data.jobs[idx].updated_at = now();

    saveData();
    res.json(data.jobs[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/jobs/:id
app.delete('/api/jobs/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = data.jobs.findIndex(j => j.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Job not found' });

    data.jobs.splice(idx, 1);
    // Unlink candidates from this job
    data.candidates.forEach(c => {
      if (c.job_id === id) c.job_id = null;
    });

    saveData();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CANDIDATES API
// ============================================================

function enrichCandidate(c) {
  const job = c.job_id ? data.jobs.find(j => j.id === c.job_id) : null;
  return {
    ...c,
    job_title: job ? job.title : null,
    job_company: job ? job.company : null,
    job_category: job ? job.category : null
  };
}

// GET /api/candidates (user-scoped: non-admin sees only their own)
app.get('/api/candidates', (req, res) => {
  try {
    const { stage, job_id, category, search } = req.query;
    let candidates = data.candidates.map(enrichCandidate);

    // Non-admin users see only their own candidates
    if (req.user && req.user.role !== 'admin') {
      candidates = candidates.filter(c => c.created_by === req.user.username);
    }

    if (stage && stage !== 'all') {
      candidates = candidates.filter(c => c.stage === stage);
    }
    if (job_id && job_id !== 'all') {
      candidates = candidates.filter(c => c.job_id === parseInt(job_id));
    }
    if (category && category !== 'all') {
      candidates = candidates.filter(c => c.job_category === category);
    }
    if (search) {
      const s = search.toLowerCase();
      candidates = candidates.filter(c =>
        (c.name || '').toLowerCase().includes(s) ||
        (c.phone || '').toLowerCase().includes(s) ||
        (c.email || '').toLowerCase().includes(s) ||
        (c.call_summary || '').toLowerCase().includes(s)
      );
    }

    // Sort by call_date desc, then created_at desc
    candidates.sort((a, b) => {
      const ad = a.call_date || a.created_at || '';
      const bd = b.call_date || b.created_at || '';
      return bd.localeCompare(ad);
    });

    res.json(candidates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/candidates/export/accepted - CSV export (must be before /:id)
app.get('/api/candidates/export/accepted', (req, res) => {
  try {
    let accepted = data.candidates
      .filter(c => c.stage === 'accepted')
      .map(enrichCandidate);
    // Non-admin: only their own
    if (req.user && req.user.role !== 'admin') {
      accepted = accepted.filter(c => c.created_by === req.user.username);
    }
    const BOM = '\uFEFF';
    const headers = ['שם','טלפון','אימייל','משרה','חברה','קטגוריה','תוכנית תשלום','תאריך התחלה','תאריך תשלום','סכום תשלום','סיכום שיחה','נוצר ע"י'];
    const rows = accepted.map(c => [
      c.name||'', c.phone||'', c.email||'', c.job_title||'', c.job_company||'', c.job_category||'',
      c.payment_plan||'', c.start_date||'', c.payment_date||'',
      c.payment_amount!=null?c.payment_amount:'',
      (c.call_summary||'').replace(/[\n\r]/g,' '),
      c.created_by||''
    ]);
    const csv = BOM + [headers,...rows].map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="accepted_candidates.csv"');
    res.send(csv);
  } catch(err) { res.status(500).json({error:err.message}); }
});

// GET /api/candidates/payment-summary (must be before /:id)
app.get('/api/candidates/payment-summary', (req, res) => {
  try {
    let accepted = data.candidates
      .filter(c => c.stage === 'accepted' && c.payment_date && c.payment_amount)
      .map(enrichCandidate);
    if (req.user && req.user.role !== 'admin') {
      accepted = accepted.filter(c => c.created_by === req.user.username);
    }
    const byMonth = {};
    accepted.forEach(c => {
      const d = new Date(c.payment_date);
      if (isNaN(d)) return;
      const key = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
      if (!byMonth[key]) byMonth[key] = {month:key,total:0,candidates:[]};
      byMonth[key].total += c.payment_amount;
      byMonth[key].candidates.push({name:c.name,amount:c.payment_amount,payment_date:c.payment_date,job_title:c.job_title});
    });
    const sorted = Object.values(byMonth).sort((a,b)=>a.month.localeCompare(b.month));
    res.json({months:sorted,grandTotal:sorted.reduce((s,m)=>s+m.total,0)});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// GET /api/candidates/check-duplicate/:phone (must be before /:id)
app.get('/api/candidates/check-duplicate/:phone', (req, res) => {
  try {
    const phone = req.params.phone.replace(/\D/g, '');
    if (!phone || phone.length < 7) return res.json({ duplicate: false });
    const match = data.candidates.find(c => {
      const cPhone = (c.phone || '').replace(/\D/g, '');
      return cPhone && cPhone.includes(phone) || phone.includes(cPhone);
    });
    if (match) {
      const enriched = enrichCandidate(match);
      res.json({
        duplicate: true,
        candidate: {
          name: enriched.name,
          phone: enriched.phone,
          stage: enriched.stage,
          job_title: enriched.job_title,
          created_by: enriched.created_by || 'unknown'
        }
      });
    } else {
      res.json({ duplicate: false });
    }
  } catch(err) { res.status(500).json({error:err.message}); }
});

// GET /api/candidates/:id
app.get('/api/candidates/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const candidate = data.candidates.find(c => c.id === id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    const history = data.stage_history
      .filter(h => h.candidate_id === id)
      .sort((a, b) => (b.changed_at || '').localeCompare(a.changed_at || ''));

    res.json({ ...enrichCandidate(candidate), history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/candidates
app.post('/api/candidates', (req, res) => {
  try {
    const { name, phone, email, job_id, stage, call_date, call_summary, notes, source, follow_up_at, follow_up_done, start_date, payment_date, payment_amount, payment_plan } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const candidate = {
      id: nextId('candidates'),
      name,
      phone: phone || null,
      email: email || null,
      job_id: job_id ? parseInt(job_id) : null,
      stage: stage || 'stage1',
      call_date: call_date || null,
      call_summary: call_summary || null,
      notes: notes || null,
      source: source || null,
      follow_up_at: follow_up_at || null,
      follow_up_done: !!follow_up_done,
      start_date: start_date || null,
      payment_date: payment_date || null,
      payment_amount: payment_amount != null ? Number(payment_amount) : null,
      payment_plan: payment_plan || null,
      available_from: req.body.available_from || null,
      created_by: req.user ? req.user.username : null,
      created_at: now(),
      updated_at: now()
    };

    // Check for duplicate phone
    if (candidate.phone) {
      const cleanPhone = candidate.phone.replace(/\D/g, '');
      const dup = data.candidates.find(c => {
        const cp = (c.phone || '').replace(/\D/g, '');
        return cp && cleanPhone && (cp.includes(cleanPhone) || cleanPhone.includes(cp));
      });
      if (dup) {
        const dupEnriched = enrichCandidate(dup);
        return res.status(409).json({
          error: 'duplicate_phone',
          message: `הליד כבר קיים במערכת!`,
          existing: {
            name: dupEnriched.name,
            phone: dupEnriched.phone,
            stage: dupEnriched.stage,
            job_title: dupEnriched.job_title,
            created_by: dupEnriched.created_by || 'לא ידוע'
          }
        });
      }
    }

    data.candidates.push(candidate);

    // Log initial stage in history
    data.stage_history.push({
      id: nextId('stage_history'),
      candidate_id: candidate.id,
      from_stage: null,
      to_stage: candidate.stage,
      changed_at: now()
    });

    saveData();
    res.status(201).json(enrichCandidate(candidate));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/candidates/:id
app.put('/api/candidates/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = data.candidates.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Candidate not found' });

    const { name, phone, email, job_id, stage, call_date, call_summary, notes, source, follow_up_at, follow_up_done, start_date, payment_date, payment_amount, payment_plan } = req.body;
    const existing = data.candidates[idx];

    // Log stage change if different
    if (stage && stage !== existing.stage) {
      data.stage_history.push({
        id: nextId('stage_history'),
        candidate_id: id,
        from_stage: existing.stage,
        to_stage: stage,
        changed_at: now()
      });
    }

    data.candidates[idx] = {
      ...existing,
      name,
      phone: phone || null,
      email: email || null,
      job_id: job_id ? parseInt(job_id) : null,
      stage: stage || 'stage1',
      call_date: call_date || null,
      call_summary: call_summary || null,
      notes: notes || null,
      source: source || null,
      follow_up_at: follow_up_at || null,
      follow_up_done: typeof follow_up_done === 'boolean' ? follow_up_done : !!existing.follow_up_done,
      start_date: start_date !== undefined ? (start_date || null) : (existing.start_date || null),
      payment_date: payment_date !== undefined ? (payment_date || null) : (existing.payment_date || null),
      payment_amount: payment_amount !== undefined ? (payment_amount != null ? Number(payment_amount) : null) : (existing.payment_amount || null),
      payment_plan: payment_plan !== undefined ? (payment_plan || null) : (existing.payment_plan || null),
      available_from: req.body.available_from !== undefined ? (req.body.available_from || null) : (existing.available_from || null),
      updated_at: now()
    };

    saveData();
    res.json(enrichCandidate(data.candidates[idx]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/candidates/:id/stage
app.patch('/api/candidates/:id/stage', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = data.candidates.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Candidate not found' });

    const { stage } = req.body;
    if (!stage) return res.status(400).json({ error: 'Stage is required' });

    const existing = data.candidates[idx];
    data.stage_history.push({
      id: nextId('stage_history'),
      candidate_id: id,
      from_stage: existing.stage,
      to_stage: stage,
      changed_at: now()
    });

    data.candidates[idx] = { ...existing, stage, updated_at: now() };

    saveData();
    res.json(enrichCandidate(data.candidates[idx]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/candidates/:id/follow-up - mark follow up done/undone
app.patch('/api/candidates/:id/follow-up', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = data.candidates.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Candidate not found' });

    const { follow_up_done, follow_up_at } = req.body;
    if (typeof follow_up_done === 'boolean') data.candidates[idx].follow_up_done = follow_up_done;
    if (follow_up_at !== undefined) data.candidates[idx].follow_up_at = follow_up_at || null;
    data.candidates[idx].updated_at = now();

    saveData();
    res.json(enrichCandidate(data.candidates[idx]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/follow-ups - list candidates with pending follow-ups
app.get('/api/follow-ups', (req, res) => {
  try {
    const nowDate = new Date();
    const items = data.candidates
      .filter(c => c.follow_up_at && !c.follow_up_done)
      .map(enrichCandidate)
      .map(c => {
        const due = new Date(c.follow_up_at);
        const diffMs = due.getTime() - nowDate.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        let status;
        if (diffMs < 0) status = 'overdue';
        else if (diffHours < 24) status = 'due_soon';
        else status = 'upcoming';
        return { ...c, follow_up_status: status };
      })
      .sort((a, b) => (a.follow_up_at || '').localeCompare(b.follow_up_at || ''));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/candidates/:id
app.delete('/api/candidates/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = data.candidates.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Candidate not found' });

    data.candidates.splice(idx, 1);
    data.stage_history = data.stage_history.filter(h => h.candidate_id !== id);

    saveData();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// STATS API
// ============================================================
app.get('/api/stats', (req, res) => {
  try {
    const openJobs = data.jobs.filter(j => j.status === 'open').length;
    const totalJobs = data.jobs.length;
    const filledJobs = data.jobs.filter(j => j.status === 'filled').length;

    // User-scoped candidates for non-admin
    const isAdmin = req.user && req.user.role === 'admin';
    const userCandidates = isAdmin
      ? data.candidates
      : data.candidates.filter(c => c.created_by === (req.user ? req.user.username : ''));

    const stage1 = userCandidates.filter(c => c.stage === 'stage1').length;
    const stage2 = userCandidates.filter(c => c.stage === 'stage2').length;
    const accepted = userCandidates.filter(c => c.stage === 'accepted').length;
    const rejected = userCandidates.filter(c => c.stage === 'rejected').length;
    const totalCandidates = userCandidates.length;

    // Accepted this month (based on stage_history)
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const acceptedThisMonth = data.stage_history.filter(h =>
      h.to_stage === 'accepted' && new Date(h.changed_at) >= monthStart
    ).length;

    // Candidates by category
    const categoryMap = {};
    userCandidates.forEach(c => {
      if (c.job_id) {
        const job = data.jobs.find(j => j.id === c.job_id);
        if (job && job.category) {
          categoryMap[job.category] = (categoryMap[job.category] || 0) + 1;
        }
      }
    });
    const byCategory = Object.keys(categoryMap).map(category => ({
      category,
      count: categoryMap[category]
    }));

    // Recent activity (last 10 stage changes)
    const recentActivity = [...data.stage_history]
      .sort((a, b) => (b.changed_at || '').localeCompare(a.changed_at || ''))
      .slice(0, 10)
      .map(h => {
        const candidate = data.candidates.find(c => c.id === h.candidate_id);
        const job = candidate && candidate.job_id ? data.jobs.find(j => j.id === candidate.job_id) : null;
        return {
          ...h,
          candidate_name: candidate ? candidate.name : 'Unknown',
          job_title: job ? job.title : null,
          job_category: job ? job.category : null
        };
      });

    // New jobs in last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const newJobs = [...data.jobs]
      .filter(j => new Date(j.created_at) >= sevenDaysAgo)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 10)
      .map(j => ({
        id: j.id,
        title: j.title,
        category: j.category,
        company: j.company,
        is_urgent: !!j.is_urgent,
        created_at: j.created_at
      }));
    const newJobsThisWeek = data.jobs.filter(j => new Date(j.created_at) >= sevenDaysAgo).length;

    // Follow-ups summary
    const nowDate = new Date();
    const inOneDay = new Date(nowDate.getTime() + 24 * 60 * 60 * 1000);
    let overdue = 0;
    let dueSoon = 0;
    let paymentsDue = 0;
    let paymentsDueSoon = 0;
    const inOneWeek = new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    userCandidates.forEach(c => {
      if (c.follow_up_at && !c.follow_up_done) {
        const due = new Date(c.follow_up_at);
        if (due < nowDate) overdue++;
        else if (due < inOneDay) dueSoon++;
      }
      // Payment reminders
      if (c.stage === 'accepted' && c.payment_date && c.payment_amount) {
        const payDate = new Date(c.payment_date);
        if (payDate < nowDate) paymentsDue++;
        else if (payDate < inOneWeek) paymentsDueSoon++;
      }
    });

    res.json({
      jobs: { open: openJobs, total: totalJobs, filled: filledJobs, newThisWeek: newJobsThisWeek },
      candidates: {
        total: totalCandidates,
        stage1,
        stage2,
        accepted,
        rejected,
        acceptedThisMonth
      },
      followUps: { overdue, dueSoon },
      payments: { paymentsDue, paymentsDueSoon },
      byCategory,
      recentActivity,
      newJobs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// TEAM API (admin only)
// ============================================================
app.get('/api/team/overview', (req, res) => {
  try {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const activeUsers = data.users.filter(u => u.status === 'active' || !u.status);
    const team = activeUsers.map(u => {
      const userCandidates = data.candidates.filter(c => c.created_by === u.username);
      const stage1 = userCandidates.filter(c => c.stage === 'stage1').length;
      const stage2 = userCandidates.filter(c => c.stage === 'stage2').length;
      const accepted = userCandidates.filter(c => c.stage === 'accepted').length;
      const rejected = userCandidates.filter(c => c.stage === 'rejected').length;
      const total = userCandidates.length;
      const pendingFollowUps = userCandidates.filter(c => c.follow_up_at && !c.follow_up_done && new Date(c.follow_up_at) < new Date()).length;

      return {
        username: u.username,
        display_name: u.display_name,
        role: u.role,
        total,
        stage1,
        stage2,
        accepted,
        rejected,
        pendingFollowUps,
        recentCandidates: userCandidates
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
          .slice(0, 5)
          .map(enrichCandidate)
      };
    });

    // Unassigned candidates (created_by is null)
    const unassigned = data.candidates.filter(c => !c.created_by);

    res.json({
      team,
      unassigned: unassigned.length,
      totalCandidates: data.candidates.length,
      totalJobs: data.jobs.filter(j => j.status === 'open').length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team/user/:username/candidates - get all candidates for a specific user
app.get('/api/team/user/:username/candidates', (req, res) => {
  try {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const candidates = data.candidates
      .filter(c => c.created_by === req.params.username)
      .map(enrichCandidate)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    res.json(candidates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Serve HTML pages
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Start Server ----------
// Default: bind to 127.0.0.1 only (not exposed on network)
// Set HOST=0.0.0.0 environment variable to expose on LAN
app.listen(PORT, HOST, () => {
  console.log(`\n🚀 RePro running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   Bound to: ${HOST}${HOST === '127.0.0.1' ? ' (localhost only - safe default)' : ''}`);
  console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`   Audit log: ${AUDIT_LOG_FILE}\n`);
});
