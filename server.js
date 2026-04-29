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
// Persistent storage: use DB_PATH env var (Railway volume) or fallback to local
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'database.json');
// Ensure parent directory exists (for Railway volumes)
try {
  const dbDir = path.dirname(DB_FILE);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
} catch (e) { console.error('Could not create DB dir:', e.message); }

// Training materials storage (PDFs, presentations) - next to DB on Railway volume
const TRAINING_DIR = process.env.TRAINING_DIR || path.join(path.dirname(DB_FILE), 'training');
try {
  if (!fs.existsSync(TRAINING_DIR)) fs.mkdirSync(TRAINING_DIR, { recursive: true });
} catch (e) { console.error('Could not create training dir:', e.message); }

// Publishing post images (for Tami's Facebook publishing manager).
// Stored next to DB so they survive Railway redeploys via the volume.
const PUBLISHING_DIR = process.env.PUBLISHING_DIR || path.join(path.dirname(DB_FILE), 'uploads', 'posts');
try {
  if (!fs.existsSync(PUBLISHING_DIR)) fs.mkdirSync(PUBLISHING_DIR, { recursive: true });
} catch (e) { console.error('Could not create publishing dir:', e.message); }

// Anthropic SDK for AI tutor (lazy init - only if API key provided)
let anthropicClient = null;
function getAnthropicClient() {
  if (anthropicClient) return anthropicClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic.default({ apiKey: key });
    console.log('✓ Anthropic SDK initialized');
    return anthropicClient;
  } catch (e) {
    console.error('Failed to init Anthropic SDK:', e.message);
    return null;
  }
}

// Extract text from a PDF file. Lazy-load pdf-parse so the app boots even
// if the library is missing (e.g. fresh deploy before npm install completes).
// Returns the text or '' on any failure.
async function extractPdfText(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const pdfParse = require('pdf-parse').default || require('pdf-parse');
    const buf = fs.readFileSync(filePath);
    const result = await pdfParse(buf);
    return (result && result.text ? result.text : '').trim();
  } catch (e) {
    console.error('PDF text extraction failed:', e.message);
    return '';
  }
}
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
  let token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  // Also accept token as query param (for file downloads via <a href>)
  if (!token && req.query && typeof req.query.token === 'string') token = req.query.token;
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
  // cdnjs.cloudflare.com is allowlisted because /learn.html lazy-loads PDF.js
  // from there to render training PDFs in-browser. blob: lets PDF.js spawn
  // its web worker.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://cdnjs.cloudflare.com",
      "frame-src 'self'",
      "form-action 'self'",
      // 'self' instead of 'none' so the PDF iframe in /learn.html can
      // load /api/training/modules/:id/view (same-origin). 'none' was
      // causing 'refused to connect' on every guide click.
      "frame-ancestors 'self'",
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

// 6b. Static serving for publishing post images. Registered EARLY so it
// runs before the auth middleware (which protects /api/*) and before
// any other route that might intercept. PUBLISHING_DIR may live on a
// Railway volume so it's not under public/. Filenames are unguessable
// (timestamp + 96 bits of randomness) so a public URL is acceptable.
app.use('/uploads/posts', express.static(PUBLISHING_DIR, {
  dotfiles: 'deny',
  etag: true,
  maxAge: '7d',
  fallthrough: false  // 404 instead of falling through to other handlers
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

const DEFAULT_COUNTRIES = [
  { id: 'usa', label_he: 'ארה"ב', label_en: 'USA', keywords: ['ניו יורק','שיקגו','סיאטל','פורטלנד','אטלנטה','מיאמי','קליפורניה','סקרמנטו','וושינגטון דיסי','מרילנד','אוהיו','בוסטון','קרוליינה','קנטקי','לאס ווגאס','פיטסבורג','ספוקן','מדפורד','רידינג','טקסס','טיילר','פאלם ספרינג','לוס אנג',"ניו ג'רזי",'מיין','ארה"ב','ארה\"ב','קונטיקט'] },
  { id: 'canada', label_he: 'קנדה', label_en: 'Canada', keywords: ['קנדה','טורונטו','ונקובר','אדמונטון','ויקטוריה','ננימו','לוויל'] },
  { id: 'australia', label_he: 'אוסטרליה', label_en: 'Australia', keywords: ['אוסטרליה','סידני','מלבורן'] },
  { id: 'philippines', label_he: 'פיליפינים', label_en: 'Philippines', keywords: ['פיליפינים','מנילה'] },
  { id: 'caribbean', label_he: 'קריביים/מקסיקו', label_en: 'Caribbean/Mexico', keywords: ['ארובה','סאן מרטין','קריביים','מקסיקו'] },
  { id: 'cyprus', label_he: 'קפריסין', label_en: 'Cyprus', keywords: ['קפריסין','פאפוס'] },
  { id: 'thailand', label_he: 'תאילנד', label_en: 'Thailand', keywords: ['תאילנד','פיסנולוק','קונקן','נקון סוואן'] },
  { id: 'china', label_he: 'סין', label_en: 'China', keywords: ['סין',"שנג'ן"] },
  { id: 'taiwan', label_he: 'טיוואן', label_en: 'Taiwan', keywords: ['טיוואן','טייפה'] }
];

const defaultData = {
  jobs: [],
  candidates: [],
  stage_history: [],
  users: defaultUsers,
  categories: DEFAULT_CATEGORIES,
  countries: DEFAULT_COUNTRIES,
  training_documents: [],
  training_conversations: [],
  // Tami's personal Facebook publishing manager. `facebook_accounts`
  // are the Facebook profiles she posts from; `facebook_groups` are FB
  // groups she's a member of (each tied to one account); `facebook_posts`
  // are draft/scheduled/published items belonging to each account.
  facebook_accounts: [],
  facebook_groups: [],
  facebook_posts: [],
  counters: {
    jobs: 0, candidates: 0, stage_history: 0,
    training_documents: 0, training_conversations: 0,
    facebook_accounts: 0, facebook_groups: 0, facebook_posts: 0
  }
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
      // Add default countries if missing (migration for existing databases)
      if (!data.countries || data.countries.length === 0) {
        data.countries = DEFAULT_COUNTRIES;
        saveData();
      }
      // Initialize training collections if missing
      if (!Array.isArray(data.training_documents)) { data.training_documents = []; saveData(); }
      if (!Array.isArray(data.training_conversations)) { data.training_conversations = []; saveData(); }
      if (!data.counters.training_documents) { data.counters.training_documents = 0; saveData(); }
      if (!data.counters.training_conversations) { data.counters.training_conversations = 0; saveData(); }
      // Initialize Facebook publishing collections if missing (migration
      // for existing databases that predate this feature)
      if (!Array.isArray(data.facebook_accounts)) { data.facebook_accounts = []; saveData(); }
      if (!Array.isArray(data.facebook_groups))   { data.facebook_groups = [];   saveData(); }
      if (!Array.isArray(data.facebook_posts))    { data.facebook_posts = [];    saveData(); }
      if (!data.counters.facebook_accounts)       { data.counters.facebook_accounts = 0; saveData(); }
      if (!data.counters.facebook_groups)         { data.counters.facebook_groups = 0;   saveData(); }
      if (!data.counters.facebook_posts)          { data.counters.facebook_posts = 0;    saveData(); }
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

// POST /api/auth/promote/:username - promote user to admin (admin only)
app.post('/api/auth/promote/:username', (req, res) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(token);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const user = data.users.find(u => u.username === req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.role = 'admin';
  user.status = 'active';
  saveData();
  auditLog('user_promoted_to_admin', { username: user.username, by: session.username });
  res.json({ success: true, message: `User ${user.username} is now admin` });
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
    const { display_name, email, avatar_url, notifications, username: newUsernameRaw } = req.body;

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

    // Username change — admin-only feature. Requires updating every place
    // the username is referenced as a foreign key (created_by fields,
    // sessions). The login token stays valid because we update the
    // session's username field in-place.
    if (newUsernameRaw !== undefined) {
      if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can change their username' });
      }
      const newUsername = validateString(newUsernameRaw, { required: true, maxLen: 32, minLen: 3 }).toLowerCase();
      if (!/^[a-z0-9._-]+$/.test(newUsername)) {
        return res.status(400).json({ error: 'שם משתמש יכול להכיל רק אותיות אנגליות, מספרים, נקודה, מקף וקו תחתון' });
      }
      if (newUsername !== user.username) {
        // Check uniqueness
        const taken = data.users.find(u => u.username === newUsername);
        if (taken) return res.status(409).json({ error: 'שם המשתמש כבר תפוס' });

        const oldUsername = user.username;
        // Update all created_by references across collections
        const updateRef = (item) => {
          if (item && item.created_by === oldUsername) item.created_by = newUsername;
          if (item && item.uploaded_by === oldUsername) item.uploaded_by = newUsername;
        };
        (data.jobs || []).forEach(updateRef);
        (data.candidates || []).forEach(updateRef);
        (data.training_documents || []).forEach(updateRef);
        (data.training_conversations || []).forEach((c) => {
          if (c && c.username === oldUsername) c.username = newUsername;
        });
        (data.facebook_accounts || []).forEach(updateRef);
        (data.facebook_posts || []).forEach(updateRef);

        // Update all sessions that point to this user (this token + any
        // others, e.g. from another browser/device)
        sessions.forEach((s) => {
          if (s.username === oldUsername) s.username = newUsername;
        });

        // Update the user record
        user.username = newUsername;
        auditLog('username_changed', { from: oldUsername, to: newUsername });
      }
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
// COUNTRIES API
// ============================================================

// GET /api/countries
app.get('/api/countries', (req, res) => {
  res.json(data.countries || []);
});

// POST /api/countries - add new country
app.post('/api/countries', (req, res) => {
  try {
    const { id, label_he, label_en, keywords } = req.body;
    if (!id || !label_he) return res.status(400).json({ error: 'id and label_he required' });
    const cleanId = id.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!data.countries) data.countries = [];
    if (data.countries.find(c => c.id === cleanId)) {
      return res.status(409).json({ error: 'Country already exists' });
    }
    const country = {
      id: cleanId,
      label_he,
      label_en: label_en || label_he,
      keywords: Array.isArray(keywords) ? keywords : (typeof keywords === 'string' ? keywords.split(',').map(k => k.trim()).filter(Boolean) : [label_he])
    };
    data.countries.push(country);
    saveData();
    res.status(201).json(country);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/countries/:id - update country (for keyword edits)
app.put('/api/countries/:id', (req, res) => {
  try {
    if (!data.countries) data.countries = [];
    const idx = data.countries.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Country not found' });
    const { label_he, label_en, keywords } = req.body;
    data.countries[idx] = {
      ...data.countries[idx],
      label_he: label_he || data.countries[idx].label_he,
      label_en: label_en || data.countries[idx].label_en,
      keywords: Array.isArray(keywords) ? keywords : (typeof keywords === 'string' ? keywords.split(',').map(k => k.trim()).filter(Boolean) : data.countries[idx].keywords)
    };
    saveData();
    res.json(data.countries[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/countries/:id
app.delete('/api/countries/:id', (req, res) => {
  try {
    if (!data.countries) data.countries = [];
    const idx = data.countries.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Country not found' });
    data.countries.splice(idx, 1);
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

// PATCH /api/candidates/:id/follow-up - mark follow up done/undone, optionally with summary + new date
app.patch('/api/candidates/:id/follow-up', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = data.candidates.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Candidate not found' });

    const { follow_up_done, follow_up_at, summary, next_follow_up_at } = req.body;
    const candidate = data.candidates[idx];

    // If marking as done with a summary → archive to history
    if (follow_up_done === true && typeof summary === 'string' && summary.trim()) {
      if (!Array.isArray(candidate.follow_up_history)) candidate.follow_up_history = [];
      candidate.follow_up_history.push({
        completed_at: now(),
        due_was: candidate.follow_up_at || null,
        summary: summary.trim()
      });
      // Also append summary to call_summary for visibility
      const stamp = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
      const appended = `\n\n[פולואפ ${stamp}]\n${summary.trim()}`;
      candidate.call_summary = (candidate.call_summary || '') + appended;
    }

    if (typeof follow_up_done === 'boolean') candidate.follow_up_done = follow_up_done;

    // Handle new follow-up date OR clear existing follow-up
    if (next_follow_up_at) {
      candidate.follow_up_at = next_follow_up_at;
      candidate.follow_up_done = false;
    } else if (follow_up_at !== undefined) {
      candidate.follow_up_at = follow_up_at || null;
    } else if (follow_up_done === true) {
      // Default: clear the follow-up when marked done (unless next_follow_up_at was provided)
      candidate.follow_up_at = null;
    }

    candidate.updated_at = now();
    saveData();
    res.json(enrichCandidate(candidate));
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
    let paymentsDue = 0; // today or overdue
    let paymentsDueSoon = 0; // tomorrow or within 3 days
    const endOfToday = new Date(nowDate); endOfToday.setHours(23, 59, 59, 999);
    const inThreeDays = new Date(nowDate.getTime() + 3 * 24 * 60 * 60 * 1000);
    userCandidates.forEach(c => {
      if (c.follow_up_at && !c.follow_up_done) {
        const due = new Date(c.follow_up_at);
        if (due < nowDate) overdue++;
        else if (due < inOneDay) dueSoon++;
      }
      // Payment reminders: today/overdue vs within 3 days
      if (c.stage === 'accepted' && c.payment_date && c.payment_amount) {
        const payDate = new Date(c.payment_date);
        if (payDate <= endOfToday) paymentsDue++;
        else if (payDate <= inThreeDays) paymentsDueSoon++;
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
// TRAINING API - Documents + AI Tutor
// ============================================================
const multer = require('multer');
const trainingStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TRAINING_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '';
    cb(null, 'td_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext);
  }
});
const trainingUpload = multer({
  storage: trainingStorage,
  // 75 MB — Canva PDFs with images can be 30-60 MB
  limits: { fileSize: 75 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowed.includes(file.mimetype) || /\.(pdf|pptx|ppt|doc|docx|txt)$/i.test(file.originalname || '')) {
      cb(null, true);
    } else {
      cb(new Error('סוג קובץ לא נתמך (נתמכים: PDF, PPTX, DOCX, TXT)'));
    }
  }
});

// GET /api/training/documents - list all training documents (admin only)
// Restricted because the documents themselves are confidential training
// material the admin doesn't want exposed to recruiter accounts. The AI
// chat still works for everyone since it reads the docs server-side.
app.get('/api/training/documents', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const docs = (data.training_documents || []).map(d => ({
      id: d.id,
      original_name: d.original_name,
      display_title: d.display_title || null,
      display_order: d.display_order != null ? d.display_order : null,
      hidden: !!d.hidden,
      size: d.size,
      mime_type: d.mime_type,
      uploaded_by: d.uploaded_by,
      uploaded_at: d.uploaded_at,
      description: d.description || null
    }));
    // Sort by display_order so the admin sees them in recruiter-view order
    docs.sort((a, b) => {
      const ao = a.display_order != null ? a.display_order : 999999;
      const bo = b.display_order != null ? b.display_order : 999999;
      if (ao !== bo) return ao - bo;
      return (a.id || 0) - (b.id || 0);
    });
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/training/documents - upload a new document (admin only)
app.post('/api/training/documents', (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  trainingUpload.single('file')(req, res, (err) => {
    if (err) {
      // Translate common multer errors to friendly Hebrew
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'הקובץ גדול מדי (מקסימום 75MB). נסי לכווץ את הקובץ או לפצל לשני חלקים.' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ' });
    try {
      // NOTE: we no longer extract PDF text synchronously here — that was
      // taking 10-30s per Canva-image PDF and timing the request out. The
      // AI chat endpoint runs its own lazy extraction the first time it
      // needs the text. Upload now returns immediately.
      const doc = {
        id: ++data.counters.training_documents,
        filename: req.file.filename,
        original_name: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
        size: req.file.size,
        mime_type: req.file.mimetype,
        uploaded_by: req.user.username,
        uploaded_at: now(),
        description: req.body.description || null,
      };
      data.training_documents.push(doc);
      saveData();
      res.status(201).json(doc);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// GET /api/training/documents/:id/file - download file (admin only)
// Same reason as the list endpoint — confidential training material.
app.get('/api/training/documents/:id/file', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const id = parseInt(req.params.id);
    const doc = (data.training_documents || []).find(d => d.id === id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const filePath = path.join(TRAINING_DIR, doc.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/training/documents/:id - update display title, sort order,
// or hidden flag. Admin only — used by the admin training page to curate
// what recruiters see and in what order.
app.patch('/api/training/documents/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const id = parseInt(req.params.id);
    const idx = (data.training_documents || []).findIndex(d => d.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const doc = data.training_documents[idx];
    if (req.body.display_title !== undefined) {
      doc.display_title = String(req.body.display_title || '').trim() || null;
    }
    if (req.body.display_order !== undefined) {
      doc.display_order = req.body.display_order != null ? Number(req.body.display_order) : null;
    }
    if (req.body.hidden !== undefined) {
      doc.hidden = !!req.body.hidden;
    }
    saveData();
    res.json({ success: true, doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/training/documents/:id - delete (admin only)
app.delete('/api/training/documents/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const id = parseInt(req.params.id);
    const idx = (data.training_documents || []).findIndex(d => d.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const doc = data.training_documents[idx];
    const filePath = path.join(TRAINING_DIR, doc.filename);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
    data.training_documents.splice(idx, 1);
    saveData();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/conversations - list current user's conversations
app.get('/api/training/conversations', (req, res) => {
  try {
    const username = req.user.username;
    const list = (data.training_conversations || [])
      .filter(c => c.user_id === username)
      .map(c => ({
        id: c.id,
        mode: c.mode,
        title: c.title || null,
        created_at: c.created_at,
        updated_at: c.updated_at,
        message_count: (c.messages || []).length
      }))
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/conversations/:id - full conversation
app.get('/api/training/conversations/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const conv = (data.training_conversations || []).find(c => c.id === id);
    if (!conv) return res.status(404).json({ error: 'Not found' });
    if (conv.user_id !== req.user.username && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/training/conversations/:id
app.delete('/api/training/conversations/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = (data.training_conversations || []).findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    if (data.training_conversations[idx].user_id !== req.user.username && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    data.training_conversations.splice(idx, 1);
    saveData();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/training/chat - send a message, get AI response
// Body: { conversation_id?, message, mode: 'qa' | 'consult' | 'scenario' | 'quiz' }
app.post('/api/training/chat', async (req, res) => {
  try {
    const client = getAnthropicClient();
    if (!client) {
      return res.status(503).json({
        error: 'ai_not_configured',
        message: 'הסוכן AI עדיין לא מחובר. מנהל המערכת צריך להגדיר ANTHROPIC_API_KEY.'
      });
    }
    const { conversation_id, message, mode = 'qa' } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

    // Build or fetch conversation
    let conv;
    if (conversation_id) {
      conv = (data.training_conversations || []).find(c => c.id === conversation_id);
      if (!conv) return res.status(404).json({ error: 'conversation not found' });
      if (conv.user_id !== req.user.username) return res.status(403).json({ error: 'Forbidden' });
    } else {
      conv = {
        id: ++data.counters.training_conversations,
        user_id: req.user.username,
        mode,
        title: (message || '').slice(0, 60),
        messages: [],
        created_at: now(),
        updated_at: now()
      };
      data.training_conversations.push(conv);
    }

    // Append user message
    conv.messages.push({ role: 'user', content: message.trim(), timestamp: now() });

    // Build system prompt based on mode.
    // Personality: warm, human, practical. Use 1-3 emojis per answer where
    // they add real meaning (not stuffed in randomly). Direct & actionable —
    // give concrete tips/steps, not abstract platitudes. Format with short
    // bullet points or numbered lists when listing more than ~3 things.
    // No self-introductions ("היי, אני העוזר שלך…") unless explicitly asked.
    const PERSONA_BASE =
      'אישיות: חבר/ה חכם/ה, חמ/ה ופרקטי/ת. ענה/י בעברית בטון של מישהו שיושב לידך ועוזר. ' +
      'השתמש/י באימוג\'ים בחכמה (1-3 בתשובה) כדי להוסיף חיים — לא לכל משפט. ' +
      'תמיד תן/י עצה קונקרטית או צעד מעשי, לא רק תיאוריה. ' +
      'כשרושמים יותר מ-3 דברים — בולטים או רשימה ממוספרת. תשובות קצרות וממוקדות עדיפות על מונולוגים. ' +
      'אל תפתח/י את התשובה בהצגה עצמית או ברכות מיותרות (לא "שלום!", לא "אני העוזר…"). ' +
      'אם המשתמש/ת שואל/ת במפורש מי את/ה — אז וגם רק אז ספר/י שאת/ה עוזר/ת AI מבוסס על חומרי ההכשרה. ' +
      'ברירת מחדל לפנייה: נקבה.';

    const systemByMode = {
      qa:
        PERSONA_BASE +
        ' תפקיד: לענות על שאלות מבוססות חומרי ההכשרה. אם השאלה לא בחומרים — ענה/י לפי היגיון מקצועי, אבל תציין/י שהמידע לא נמצא במפורש בחומר. שלב/י דוגמה ספציפית כשאפשר. 💡',
      consult:
        PERSONA_BASE +
        ' תפקיד: יעוץ מעשי במצבים שהמגייסת נתקלת בהם. שאל/י שאלת הבהרה רק אם באמת חסר מידע. ' +
        'תן/י עצה קונקרטית: מה לומר, מה לעשות, באיזה סדר. אם רלוונטי, צי\'/ני 2-3 דרכי פעולה אפשריות והסבר/י את היתרונות/חסרונות של כל אחת. 🎯',
      scenario:
        PERSONA_BASE +
        ' תפקיד: משחק/ת תפקיד של מועמד/ת או מעסיק/ה לתרגול. כנס/י לתפקיד מיידית בלי לקרוא לעצמך AI. ' +
        'צור/י דמות אמינה — שם, רקע, אופי. השלבי התנגדויות וקושיות אמיתיות. אם המגייסת מבקשת משוב, צא/י מהדמות ותן/י משוב בונה ומפורט: מה היה טוב, מה ניסי לשפר. 🎭',
      quiz:
        PERSONA_BASE +
        ' תפקיד: בוחן/ת על חומר ההכשרה. שאלה אחת בכל פעם — בלי הקדמות. ' +
        'אחרי כל תשובה תן/י משוב קצר ומדויק (✓ נכון / ✗ לא נכון) + הסבר. עבור/י בין נושאים. ' +
        'אחרי 5 שאלות תן/י סיכום קצר של ההתקדמות. 📝',
    };
    const systemText = systemByMode[mode] || systemByMode.qa;

    // Load training docs and ensure each has extracted text (back-fills any
    // pre-existing PDFs from before the text-extraction feature shipped).
    const docs = (data.training_documents || []).filter(d => /pdf/i.test(d.mime_type || '') || /\.pdf$/i.test(d.filename || ''));
    let backfilled = false;
    for (const doc of docs) {
      if (!doc.extracted_text || doc.extracted_text.length === 0) {
        const filePath = path.join(TRAINING_DIR, doc.filename);
        doc.extracted_text = await extractPdfText(filePath);
        backfilled = true;
      }
    }
    if (backfilled) saveData();

    // Build a SINGLE compact text block that summarizes all training
    // materials. Send it as a cached system block — that way:
    //   1. Each document's text only counts once toward our 30K/min limit.
    //   2. After the first request, the cache hit keeps subsequent calls
    //      under ~1K input tokens (huge cost saver).
    //   3. It scales to many documents better than sending raw PDFs.
    const MAX_DOC_CHARS = 60000; // ~15K tokens, well under 30K/min
    const usableDocs = docs.filter(d => d.extracted_text && d.extracted_text.length > 0);
    let trainingContext = '';
    if (usableDocs.length > 0) {
      let total = 0;
      const parts = [];
      for (let i = 0; i < usableDocs.length; i++) {
        const d = usableDocs[i];
        const header = `\n\n=== חומר הכשרה ${i + 1}: ${d.original_name} ===\n\n`;
        const remaining = MAX_DOC_CHARS - total - header.length;
        if (remaining <= 200) {
          parts.push(`\n\n[נחתך — נותרו ${usableDocs.length - i} חומרי הכשרה נוספים שלא נכנסו לקונטקסט]`);
          break;
        }
        const text = d.extracted_text.length > remaining
          ? d.extracted_text.slice(0, remaining) + '\n\n[נחתך]'
          : d.extracted_text;
        parts.push(header + text);
        total += header.length + text.length;
      }
      trainingContext = parts.join('');
    }

    // Build the system parameter — text + cached training context.
    const systemParam = trainingContext
      ? [
          { type: 'text', text: systemText },
          {
            type: 'text',
            text: `להלן חומרי ההכשרה של RePro שעלייך להתבסס עליהם בתשובות:${trainingContext}`,
            cache_control: { type: 'ephemeral' },
          },
        ]
      : systemText;

    // Replay the conversation in messages — no PDF/document blocks needed
    // because the docs now live in the cached system prompt.
    const claudeMessages = conv.messages.map((m) => ({ role: m.role, content: m.content }));

    // Call Claude API
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system: systemParam,
      messages: claudeMessages,
    });

    const assistantText = (response.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // Append assistant message + persist
    conv.messages.push({ role: 'assistant', content: assistantText, timestamp: now() });
    conv.updated_at = now();
    saveData();

    res.json({
      conversation_id: conv.id,
      message: assistantText,
      usage: response.usage || null
    });
  } catch (err) {
    console.error('Training chat error:', err);
    res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// Cleans up a raw PDF filename → human-readable Hebrew title.
//   "REPRO_2.pdf"  → "מודול 2"
//   "MODULE_3.pdf" → "מודול 3"
//   "intro_lesson.pdf" → "Intro Lesson"
function prettifyDocTitle(originalName, fallbackOrder) {
  let s = (originalName || '').replace(/\.pdf$/i, '').trim();
  // Common pattern: "REPRO_3" or "MODULE_5" → "מודול 3"
  const m = s.match(/^(?:repro|module|lesson|chapter)[_\s-]*(\d+)$/i);
  if (m) return `מודול ${m[1]}`;
  // Replace underscores/dashes with spaces, normalize whitespace
  s = s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // If we still have nothing useful, fall back to "מודול N"
  if (!s) return `מודול ${fallbackOrder}`;
  return s;
}

// GET /api/training/modules - list training modules visible to recruiters.
// Returns title + intro text (first ~280 chars) for each PDF, but NEVER
// links to the file itself. Anyone authenticated can call this.
//
// Filtering: documents marked hidden=true are excluded.
// Ordering: display_order (if set) wins over insertion order.
// Title: display_title (admin-curated) wins over the prettified filename.
//
// Performance: NO PDF text extraction here. The iframe viewer reads the
// raw PDF, so we don't need extracted text for the recruiter UI. The AI
// chat endpoint runs its own lazy extraction when needed. Skipping this
// step keeps the modules list snappy (was timing out on 7-PDF Canva
// libraries because pdf-parse is slow on image-only slides).
app.get('/api/training/modules', (req, res) => {
  try {
    let docs = (data.training_documents || [])
      .filter(d => /pdf/i.test(d.mime_type || '') || /\.pdf$/i.test(d.filename || ''))
      .filter(d => !d.hidden);

    docs.sort((a, b) => {
      const ao = a.display_order != null ? Number(a.display_order) : 999999;
      const bo = b.display_order != null ? Number(b.display_order) : 999999;
      if (ao !== bo) return ao - bo;
      return (a.id || 0) - (b.id || 0);
    });

    const modules = docs.map((d, i) => {
      const text = d.extracted_text || '';
      const intro = text.replace(/\s+/g, ' ').slice(0, 280).trim();
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      const title = d.display_title && d.display_title.trim()
        ? d.display_title.trim()
        : prettifyDocTitle(d.original_name, i + 1);
      return {
        id: d.id,
        order: i + 1,
        title,
        intro,
        word_count: wordCount,
        has_text: text.length > 100,
        reading_minutes: Math.max(1, Math.round(wordCount / 180)),
      };
    });
    res.json(modules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/modules/:id/view - stream the raw PDF for in-browser
// rendering. Any authenticated user can view; the file is streamed inline
// with same-origin frame protection so other sites can't embed it.
//
// Caching: we use ETag + private 1-hour cache. After a recruiter views
// a guide once, the PDF lives in her browser cache; subsequent clicks
// load instantly without re-downloading the (often 10MB+) file.
// 'private' keeps it out of any shared CDN/proxy cache for safety.
app.get('/api/training/modules/:id/view', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const doc = (data.training_documents || []).find(d => d.id === id);
    if (!doc) return res.status(404).json({ error: 'Module not found' });
    const filePath = path.join(TRAINING_DIR, doc.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });

    // ETag derived from id + size + uploaded_at — changes only if the
    // file is replaced (delete + re-upload), in which case the etag
    // shifts and the browser re-downloads.
    const stat = fs.statSync(filePath);
    const etag = '"m' + id + '-' + stat.size + '-' + stat.mtimeMs.toString(36) + '"';
    res.setHeader('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Private 1-hour cache so opening the same guide twice is instant.
    // 'must-revalidate' makes the browser re-check with the server when
    // the cache expires; combined with ETag, that's a fast 304 round-trip.
    res.setHeader('Cache-Control', 'private, max-age=3600, must-revalidate');

    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/modules/:id - return the styled-readable text body
// for a single module. No download URL, no raw PDF — just the extracted
// text so the client renders it in a custom viewer.
app.get('/api/training/modules/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const doc = (data.training_documents || []).find(d => d.id === id);
    if (!doc) return res.status(404).json({ error: 'Module not found' });

    if (!doc.extracted_text) {
      const filePath = path.join(TRAINING_DIR, doc.filename);
      doc.extracted_text = await extractPdfText(filePath);
      saveData();
    }
    // Find the doc's order in the prettified module list so the title
    // here matches the card label the user just clicked.
    const allDocs = (data.training_documents || []).filter(d =>
      /pdf/i.test(d.mime_type || '') || /\.pdf$/i.test(d.filename || ''),
    );
    const order = allDocs.findIndex(d => d.id === doc.id) + 1;
    res.json({
      id: doc.id,
      order,
      title: prettifyDocTitle(doc.original_name, order),
      content: doc.extracted_text || '',
      uploaded_at: doc.uploaded_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/training/disclaimer-accept - log that this user agreed to the
// confidentiality disclaimer. Best-effort audit trail kept in audit.log
// so we have a paper trail if someone leaves and misuses materials.
app.post('/api/training/disclaimer-accept', (req, res) => {
  try {
    const version = (req.body && req.body.version) || 'unknown';
    auditLog('training_disclaimer_accepted', {
      username: req.user.username,
      role: req.user.role,
      ip: getClientIp(req),
      version,
    });
    // Also stamp the user's record so admins can see it from /api/auth/users.
    const userIdx = (data.users || []).findIndex(u => u.username === req.user.username);
    if (userIdx !== -1) {
      data.users[userIdx].disclaimer_accepted_at = now();
      data.users[userIdx].disclaimer_version = version;
      saveData();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/training/status - is AI configured?
app.get('/api/training/status', (req, res) => {
  res.json({
    ai_enabled: !!getAnthropicClient(),
    document_count: (data.training_documents || []).length
  });
});

// ============================================================
// PUBLISHING API — Tami's Facebook publishing manager (admin-only)
// ============================================================
// Lets the admin manage multiple Facebook accounts and the posts she
// publishes on each. Each post can have a text body, an optional image,
// status (draft / scheduled / published), tags, and a publish date.
// All endpoints are admin-gated; recruiters never see this data.

// Multer config for post images. 10MB cap, common image formats only.
// Re-creates the destination directory on every upload in case the volume
// was re-mounted or the dir was deleted between requests.
const publishingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (!fs.existsSync(PUBLISHING_DIR)) {
        fs.mkdirSync(PUBLISHING_DIR, { recursive: true });
      }
      cb(null, PUBLISHING_DIR);
    } catch (e) {
      console.error('Could not create PUBLISHING_DIR:', e.message);
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    cb(null, 'p_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext);
  }
});
const publishingUpload = multer({
  storage: publishingStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — plenty for FB images
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype) || /\.(jpe?g|png|webp|gif)$/i.test(file.originalname || '')) {
      cb(null, true);
    } else {
      cb(new Error('סוג תמונה לא נתמך (נתמכים: JPG, PNG, WEBP, GIF)'));
    }
  }
});

// (Static serving for /uploads/posts is registered early in the file,
// near the public/ static handler — see "6b" above. Doing it there
// instead of here ensures it runs before the auth middleware and
// before any route that might intercept the path.)

// Authenticated fallback for serving post images. Used by the frontend
// when a direct <img src="/uploads/posts/..."> can't be served (e.g.
// some hosting environments restrict static serving outside the project
// root). The frontend falls back to /api/publishing/image/:filename
// with a token query string so <img> tags can still authenticate.
app.get('/api/publishing/image/:filename', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const filename = req.params.filename || '';
  // Defense against path traversal — only allow our uploaded filename pattern
  if (!/^p_\d+_[a-f0-9]+\.[a-z0-9]+$/i.test(filename)) {
    return res.status(400).json({ error: 'Bad filename' });
  }
  const fpath = path.join(PUBLISHING_DIR, filename);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Image not found' });
  // Set a sensible Content-Type from extension
  const ext = path.extname(filename).toLowerCase();
  const ct = ext === '.png'  ? 'image/png'
           : ext === '.gif'  ? 'image/gif'
           : ext === '.webp' ? 'image/webp'
           : 'image/jpeg';
  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'private, max-age=604800');
  fs.createReadStream(fpath).pipe(res);
});

// --- Helpers ---------------------------------------------------------
const PUB_VALID_STATUSES = ['draft', 'scheduled', 'published'];
const PUB_VALID_COLORS   = ['#0073ea', '#00c875', '#a358df', '#fdab3d', '#ec4899', '#e2445c'];

function requireAdmin(req, res) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' });
    return false;
  }
  return true;
}

function findAccount(id) {
  const numId = parseInt(id, 10);
  return data.facebook_accounts.find(a => a.id === numId);
}
function findPost(id) {
  const numId = parseInt(id, 10);
  return data.facebook_posts.find(p => p.id === numId);
}

// Serialize an account with a post-count breakdown by status, so the
// frontend can show "3 drafts / 5 scheduled / 12 published" badges
// without an extra API call.
function serializeAccount(acc) {
  const posts = data.facebook_posts.filter(p => p.account_id === acc.id);
  const counts = { draft: 0, scheduled: 0, published: 0, total: posts.length };
  for (const p of posts) {
    if (counts[p.status] != null) counts[p.status]++;
  }
  return { ...acc, counts };
}

// --- Accounts CRUD ---------------------------------------------------

// GET /api/publishing/accounts — list all of admin's Facebook accounts
app.get('/api/publishing/accounts', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const accounts = (data.facebook_accounts || [])
    .slice()
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.id - b.id))
    .map(serializeAccount);
  res.json(accounts);
});

// POST /api/publishing/accounts — create a new Facebook account
app.post('/api/publishing/accounts', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const name = validateString(req.body?.name, { required: true, maxLen: 80, minLen: 1 });
    const profile_url = req.body?.profile_url
      ? validateString(req.body.profile_url, { required: false, maxLen: 500 })
      : null;
    let color = req.body?.color || '#0073ea';
    if (!PUB_VALID_COLORS.includes(color)) color = '#0073ea';
    const icon = req.body?.icon ? String(req.body.icon).slice(0, 8) : '👤';

    const account = {
      id: nextId('facebook_accounts'),
      name,
      profile_url,
      color,
      icon,
      sort_order: data.facebook_accounts.length,
      created_by: req.user.username,
      created_at: new Date().toISOString()
    };
    data.facebook_accounts.push(account);
    saveData();
    auditLog('publishing_account_create', { id: account.id, name, by: req.user.username });
    res.status(201).json(serializeAccount(account));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/publishing/accounts/:id — update an account
app.put('/api/publishing/accounts/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const acc = findAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  try {
    if (req.body.name !== undefined) {
      acc.name = validateString(req.body.name, { required: true, maxLen: 80, minLen: 1 });
    }
    if (req.body.profile_url !== undefined) {
      acc.profile_url = req.body.profile_url
        ? validateString(req.body.profile_url, { required: false, maxLen: 500 })
        : null;
    }
    if (req.body.color !== undefined && PUB_VALID_COLORS.includes(req.body.color)) {
      acc.color = req.body.color;
    }
    if (req.body.icon !== undefined) {
      acc.icon = String(req.body.icon).slice(0, 8);
    }
    if (req.body.sort_order !== undefined) {
      acc.sort_order = parseInt(req.body.sort_order, 10) || 0;
    }
    saveData();
    res.json(serializeAccount(acc));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/publishing/accounts/:id — delete an account AND all its posts
app.delete('/api/publishing/accounts/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const acc = findAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });

  // Cascade-delete posts; also unlink any uploaded images from disk
  const postsToDelete = data.facebook_posts.filter(p => p.account_id === acc.id);
  for (const post of postsToDelete) {
    if (post.image_url && post.image_url.startsWith('/uploads/posts/')) {
      const fname = post.image_url.replace(/^\/uploads\/posts\//, '');
      const fpath = path.join(PUBLISHING_DIR, fname);
      try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); } catch (e) { console.warn('Could not delete', fpath, e.message); }
    }
  }
  const groupsDeleted = (data.facebook_groups || []).filter(g => g.account_id === acc.id).length;
  data.facebook_groups = data.facebook_groups.filter(g => g.account_id !== acc.id);
  data.facebook_posts = data.facebook_posts.filter(p => p.account_id !== acc.id);
  data.facebook_accounts = data.facebook_accounts.filter(a => a.id !== acc.id);
  saveData();
  auditLog('publishing_account_delete', { id: acc.id, name: acc.name, posts_deleted: postsToDelete.length, groups_deleted: groupsDeleted, by: req.user.username });
  res.json({ success: true, posts_deleted: postsToDelete.length, groups_deleted: groupsDeleted });
});

// --- Posts CRUD ------------------------------------------------------

// GET /api/publishing/posts — list posts (filterable by account_id, status, tag, q)
app.get('/api/publishing/posts', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let posts = (data.facebook_posts || []).slice();

  if (req.query.account_id) {
    const aid = parseInt(req.query.account_id, 10);
    posts = posts.filter(p => p.account_id === aid);
  }
  if (req.query.status && PUB_VALID_STATUSES.includes(req.query.status)) {
    posts = posts.filter(p => p.status === req.query.status);
  }
  if (req.query.tag) {
    const tag = String(req.query.tag).toLowerCase();
    posts = posts.filter(p => (p.tags || []).some(t => String(t).toLowerCase() === tag));
  }
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    posts = posts.filter(p => (p.text || '').toLowerCase().includes(q));
  }

  // Sort: most recently updated first
  posts.sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
  res.json(posts);
});

// POST /api/publishing/posts — create a new post
app.post('/api/publishing/posts', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const account_id = parseInt(req.body?.account_id, 10);
    if (!account_id || !findAccount(account_id)) {
      return res.status(400).json({ error: 'Invalid account_id' });
    }
    const title = req.body?.title != null
      ? validateString(req.body.title, { required: false, maxLen: 200 })
      : '';
    const text = req.body?.text != null
      ? validateString(req.body.text, { required: false, maxLen: 5000 })
      : '';
    let status = req.body?.status || 'draft';
    if (!PUB_VALID_STATUSES.includes(status)) status = 'draft';
    const images = Array.isArray(req.body?.images)
      ? req.body.images.map(u => String(u).slice(0, 500)).filter(Boolean).slice(0, 10)
      : [];
    // image_url = the currently-selected image (for cards/copy). Defaults
    // to the first one in the list. If body sends image_url separately,
    // we accept it as long as it's in `images` (or null to clear).
    let image_url = req.body?.image_url ? String(req.body.image_url).slice(0, 500) : null;
    if (image_url && images.length > 0 && !images.includes(image_url)) {
      // Selected image wasn't in the list — assume it should be added
      images.push(image_url);
    } else if (!image_url && images.length > 0) {
      image_url = images[0];
    }
    const reference_url = req.body?.reference_url
      ? String(req.body.reference_url).slice(0, 500)
      : null;
    const tags = Array.isArray(req.body?.tags)
      ? req.body.tags.map(t => String(t).trim().slice(0, 32)).filter(Boolean).slice(0, 20)
      : [];
    const publish_date = req.body?.publish_date ? String(req.body.publish_date).slice(0, 32) : null;

    const now = new Date().toISOString();
    const post = {
      id: nextId('facebook_posts'),
      account_id,
      title,
      text,
      image_url,
      images,
      reference_url,
      tags,
      status,
      publish_date,
      created_at: now,
      updated_at: now,
      created_by: req.user.username
    };
    data.facebook_posts.push(post);
    saveData();
    res.status(201).json(post);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/publishing/posts/:id — update a post
app.put('/api/publishing/posts/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const post = findPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  try {
    if (req.body.account_id !== undefined) {
      const aid = parseInt(req.body.account_id, 10);
      if (!aid || !findAccount(aid)) return res.status(400).json({ error: 'Invalid account_id' });
      post.account_id = aid;
    }
    if (req.body.title !== undefined) {
      post.title = validateString(req.body.title, { required: false, maxLen: 200 }) || '';
    }
    if (req.body.text !== undefined) {
      post.text = validateString(req.body.text, { required: false, maxLen: 5000 }) || '';
    }
    if (req.body.images !== undefined) {
      const newList = Array.isArray(req.body.images)
        ? req.body.images.map(u => String(u).slice(0, 500)).filter(Boolean).slice(0, 10)
        : [];
      // Delete files that were dropped from the list (cleanup orphan uploads)
      const oldList = post.images || (post.image_url ? [post.image_url] : []);
      const removed = oldList.filter(u => !newList.includes(u));
      for (const url of removed) {
        if (url.startsWith('/uploads/posts/')) {
          const fname = url.replace(/^\/uploads\/posts\//, '');
          const fpath = path.join(PUBLISHING_DIR, fname);
          try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); } catch {}
        }
      }
      post.images = newList;
    }
    if (req.body.image_url !== undefined) {
      const requested = req.body.image_url ? String(req.body.image_url).slice(0, 500) : null;
      // If requested URL exists in our images list (or is null), accept.
      // Otherwise default to the first image (or null).
      const list = post.images || [];
      if (!requested) {
        post.image_url = null;
      } else if (list.includes(requested)) {
        post.image_url = requested;
      } else if (list.length > 0) {
        post.image_url = list[0];
      } else {
        // Backward-compat path: no images list yet, so just store as-is
        post.image_url = requested;
      }
    } else if (req.body.images !== undefined) {
      // images changed but image_url didn't — auto-pick first if current
      // selection no longer exists, else keep
      const list = post.images || [];
      if (post.image_url && !list.includes(post.image_url)) {
        post.image_url = list[0] || null;
      } else if (!post.image_url && list.length > 0) {
        post.image_url = list[0];
      }
    }
    if (req.body.reference_url !== undefined) {
      post.reference_url = req.body.reference_url
        ? String(req.body.reference_url).slice(0, 500)
        : null;
    }
    if (req.body.tags !== undefined) {
      post.tags = Array.isArray(req.body.tags)
        ? req.body.tags.map(t => String(t).trim().slice(0, 32)).filter(Boolean).slice(0, 20)
        : [];
    }
    if (req.body.status !== undefined && PUB_VALID_STATUSES.includes(req.body.status)) {
      post.status = req.body.status;
    }
    if (req.body.publish_date !== undefined) {
      post.publish_date = req.body.publish_date ? String(req.body.publish_date).slice(0, 32) : null;
    }
    post.updated_at = new Date().toISOString();
    saveData();
    res.json(post);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/publishing/posts/:id — delete a post (and its images, if any)
app.delete('/api/publishing/posts/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const idx = data.facebook_posts.findIndex(p => p.id === parseInt(req.params.id, 10));
  if (idx === -1) return res.status(404).json({ error: 'Post not found' });
  const post = data.facebook_posts[idx];
  // Clean up every image attached to this post (the gallery as a whole)
  const allImages = new Set([...(post.images || []), post.image_url].filter(Boolean));
  for (const url of allImages) {
    if (url.startsWith('/uploads/posts/')) {
      const fname = url.replace(/^\/uploads\/posts\//, '');
      const fpath = path.join(PUBLISHING_DIR, fname);
      try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); } catch {}
    }
  }
  data.facebook_posts.splice(idx, 1);
  saveData();
  res.json({ success: true });
});

// POST /api/publishing/posts/:id/duplicate — clone a post as a fresh draft
app.post('/api/publishing/posts/:id/duplicate', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orig = findPost(req.params.id);
  if (!orig) return res.status(404).json({ error: 'Post not found' });
  const now = new Date().toISOString();
  // Note: duplicated post points to the SAME image_url. We don't copy
  // the file — multiple posts can reference the same image just fine,
  // and this saves disk + matches the user's likely intent (small
  // variations of the same announcement).
  const dup = {
    id: nextId('facebook_posts'),
    account_id: req.body?.account_id ? parseInt(req.body.account_id, 10) : orig.account_id,
    title: orig.title || '',
    text: orig.text,
    image_url: orig.image_url,
    images: Array.isArray(orig.images) ? orig.images.slice() : (orig.image_url ? [orig.image_url] : []),
    reference_url: orig.reference_url || null,
    tags: Array.isArray(orig.tags) ? orig.tags.slice() : [],
    status: 'draft',         // always start as draft
    publish_date: null,
    created_at: now,
    updated_at: now,
    created_by: req.user.username
  };
  if (!findAccount(dup.account_id)) dup.account_id = orig.account_id;
  data.facebook_posts.push(dup);
  saveData();
  res.status(201).json(dup);
});

// PATCH /api/publishing/posts/:id/move — move post to another account
app.patch('/api/publishing/posts/:id/move', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const post = findPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const newAccountId = parseInt(req.body?.account_id, 10);
  if (!newAccountId || !findAccount(newAccountId)) {
    return res.status(400).json({ error: 'Invalid target account_id' });
  }
  post.account_id = newAccountId;
  post.updated_at = new Date().toISOString();
  saveData();
  res.json(post);
});

// --- Groups CRUD (Facebook groups belonging to an account) ---------

function findGroup(id) {
  const numId = parseInt(id, 10);
  return data.facebook_groups.find(g => g.id === numId);
}

// GET /api/publishing/groups?account_id=X — list groups (filter by account)
app.get('/api/publishing/groups', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let groups = (data.facebook_groups || []).slice();
  if (req.query.account_id) {
    const aid = parseInt(req.query.account_id, 10);
    groups = groups.filter(g => g.account_id === aid);
  }
  groups.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.id - b.id));
  res.json(groups);
});

// POST /api/publishing/groups — create a new group under an account
app.post('/api/publishing/groups', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const account_id = parseInt(req.body?.account_id, 10);
    if (!account_id || !findAccount(account_id)) {
      return res.status(400).json({ error: 'Invalid account_id' });
    }
    const name = validateString(req.body?.name, { required: true, maxLen: 100, minLen: 1 });
    const url = req.body?.url ? validateString(req.body.url, { required: false, maxLen: 500 }) : null;

    const group = {
      id: nextId('facebook_groups'),
      account_id,
      name,
      url,
      sort_order: data.facebook_groups.filter(g => g.account_id === account_id).length,
      created_at: new Date().toISOString(),
      created_by: req.user.username
    };
    data.facebook_groups.push(group);
    saveData();
    res.status(201).json(group);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/publishing/groups/:id — update a group
app.put('/api/publishing/groups/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const grp = findGroup(req.params.id);
  if (!grp) return res.status(404).json({ error: 'Group not found' });
  try {
    if (req.body.name !== undefined) {
      grp.name = validateString(req.body.name, { required: true, maxLen: 100, minLen: 1 });
    }
    if (req.body.url !== undefined) {
      grp.url = req.body.url ? validateString(req.body.url, { required: false, maxLen: 500 }) : null;
    }
    if (req.body.account_id !== undefined) {
      const aid = parseInt(req.body.account_id, 10);
      if (!aid || !findAccount(aid)) return res.status(400).json({ error: 'Invalid account_id' });
      grp.account_id = aid;
    }
    if (req.body.sort_order !== undefined) {
      grp.sort_order = parseInt(req.body.sort_order, 10) || 0;
    }
    saveData();
    res.json(grp);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/publishing/groups/:id — delete a group
app.delete('/api/publishing/groups/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const idx = data.facebook_groups.findIndex(g => g.id === parseInt(req.params.id, 10));
  if (idx === -1) return res.status(404).json({ error: 'Group not found' });
  data.facebook_groups.splice(idx, 1);
  saveData();
  res.json({ success: true });
});

// GET /api/publishing/tags — return all unique tags across all posts
app.get('/api/publishing/tags', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const set = new Set();
  for (const p of data.facebook_posts || []) {
    for (const t of (p.tags || [])) set.add(t);
  }
  const tags = Array.from(set).sort((a, b) => a.localeCompare(b, 'he'));
  res.json(tags);
});

// POST /api/publishing/upload-image — upload an image, return its URL
app.post('/api/publishing/upload-image', (req, res) => {
  if (!requireAdmin(req, res)) return;
  publishingUpload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Upload-image multer error:', err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'התמונה גדולה מדי (מקסימום 10MB)' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'לא הועלתה תמונה' });
    // Verify the file actually landed on disk (Railway volumes can fail
    // silently if not mounted; this catches that case).
    const fpath = path.join(PUBLISHING_DIR, req.file.filename);
    if (!fs.existsSync(fpath)) {
      console.error('Upload claimed success but file not on disk:', fpath);
      return res.status(500).json({ error: 'התמונה לא נשמרה לדיסק. בדקי שיש Volume מחובר ב-Railway.' });
    }
    console.log('Image uploaded:', req.file.filename, '(' + req.file.size + ' bytes) to ' + fpath);
    res.status(201).json({
      url: '/uploads/posts/' + req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  });
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
