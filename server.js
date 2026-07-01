require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, moveTo, appendBezierCurve, closePath, clip, endPath } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const QRCode  = require('qrcode');
const nodemailer = require('nodemailer');

// ── Campaign Monitor SMTP transporter ────────────────────────
// Set CM_API_KEY and CM_FROM_EMAIL in Railway environment variables
const _mailer = nodemailer.createTransport({
  host: 'smtp.createsend.com',
  port: 587,
  auth: {
    user: process.env.CM_API_KEY || '',
    pass: process.env.CM_API_KEY || ''
  }
});

const app  = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

// ── Airtable config ──────────────────────────────────────────
const AT_KEY      = process.env.AIRTABLE_API_KEY;
const AT_BASE     = 'appqQv0Xog8yZMwI9';
const AT_TABLE    = 'tbltcinwWF3FXDGre';
// Field IDs
const F_EMAIL     = 'fldVx5xRa7lXK3SC3';
const F_PASSWORD  = 'fldWYSyK5TWesxobj';
const F_SAL       = 'fldzdw3RKozmShmEr';
const F_FIRST     = 'flde9n3BkKQsJFoYB';
const F_LAST      = 'flduFe3YHfQB7f7LQ';
const F_TITLE     = 'flddJxQNvOYVOAud7';
const F_MOBILE    = 'fldtBa4TSYjbE3nDY';
const F_LANDLINE  = 'fldpF1q0oD0Hhastr';
const F_WEBSITE   = 'fld31BHXAjONR2GGR';
const F_ADMIN          = 'fldX7dyR6P45kAXqU';
const F_MORTGAGES      = 'fldSYyjEeiQYqSl3b';
const F_PROTECTION     = 'fldpLRcjuGeL1muYF';
const F_INVESTMENTS    = 'fld7C7E8seECPWbNh';
const F_IS_SUPERVISOR  = 'fldhOYcUHF3SrnC5C';
const F_SUPERVISOR_EMAIL = 'fldvyCzxvpIEjD7PU';
const F_CO_SUPERVISES  = 'fld2fG2C8sK9PQ3o2'; // "Co-supervises Email" — shares team view with
const F_AVATAR         = 'fldiQ06FtP4BehJU7';

// ── Marketing users (local, no Airtable field needed) ─────────
const MARKETING_USERS_PATH = path.join(__dirname, 'marketing-users.json');
let _marketingUsers = new Set();
try { _marketingUsers = new Set(JSON.parse(fs.readFileSync(MARKETING_USERS_PATH, 'utf8'))); } catch(_) {}

// ── Extra products (local) — Equity Release, Commercial Mortgages ──
const EXTRA_PRODUCTS_PATH = path.join(__dirname, 'extra-products.json');
let _extraProducts = {}; // { "email": { equityRelease: true, commercialMortgages: false } }
try { _extraProducts = JSON.parse(fs.readFileSync(EXTRA_PRODUCTS_PATH, 'utf8')); } catch(_) {}
function saveExtraProducts() { fs.writeFileSync(EXTRA_PRODUCTS_PATH, JSON.stringify(_extraProducts, null, 2)); }
function getExtraProducts(email) { return _extraProducts[(email||'').toLowerCase()] || {}; }

// ── Login attempt tracking (in-memory, resets on restart) ────────
// { "email@x.com": { count: 3, lockedUntil: <ms timestamp> } }
const _loginAttempts = {};
const LOGIN_MAX      = 3;
const LOGIN_LOCK_MS  = 15 * 60 * 1000; // 15 minutes

function recordFailedLogin(email) {
  const e = email.toLowerCase();
  if (!_loginAttempts[e]) _loginAttempts[e] = { count: 0, lockedUntil: 0 };
  _loginAttempts[e].count++;
  if (_loginAttempts[e].count >= LOGIN_MAX) {
    _loginAttempts[e].lockedUntil = Date.now() + LOGIN_LOCK_MS;
  }
}
function clearLoginAttempts(email) {
  delete _loginAttempts[email.toLowerCase()];
}
function getLoginLockStatus(email) {
  const rec = _loginAttempts[email.toLowerCase()];
  if (!rec) return { locked: false, attemptsLeft: LOGIN_MAX };
  if (rec.lockedUntil > Date.now()) {
    const minsLeft = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    return { locked: true, minsLeft };
  }
  // Lock expired
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) delete _loginAttempts[email.toLowerCase()];
  const attemptsLeft = Math.max(0, LOGIN_MAX - (rec.count || 0));
  return { locked: false, attemptsLeft };
}

// ── Password reset tokens (in-memory, 1-hour TTL) ────────────────
// { "token": { email, expires } }
const _resetTokens = {};
function createResetToken(email) {
  const token = crypto.randomBytes(32).toString('hex');
  _resetTokens[token] = { email: email.toLowerCase(), expires: Date.now() + 3600000 };
  return token;
}
function consumeResetToken(token) {
  const rec = _resetTokens[token];
  if (!rec) return null;
  if (rec.expires < Date.now()) { delete _resetTokens[token]; return null; }
  delete _resetTokens[token];
  return rec.email;
}

// ── Asset dates manifest (persists upload dates across deploys) ──
const ASSET_DATES_PATH = path.join(__dirname, 'asset-dates.json');
let _assetDates = {};
try { _assetDates = JSON.parse(fs.readFileSync(ASSET_DATES_PATH, 'utf8')); } catch(_) {}
function getAssetDate(key) {
  if (!_assetDates[key]) {
    _assetDates[key] = new Date().toISOString();
    try { fs.writeFileSync(ASSET_DATES_PATH, JSON.stringify(_assetDates, null, 2)); } catch(_) {}
  }
  return _assetDates[key];
}

// ── Featured social posts ──────────────────────────────────────
const FEATURED_SOCIAL_PATH = path.join(__dirname, 'featured-social.json');
let _featuredSocial = [];
try { _featuredSocial = JSON.parse(fs.readFileSync(FEATURED_SOCIAL_PATH, 'utf8')); } catch(_) {}

// ── Feature flags ─────────────────────────────────────────────
const FEATURES_PATH = path.join(__dirname, 'features.json');
const FEATURES_DEFAULT = {
  marketing: true, compliance: true, adviceStandards: true,
  learning: true, surveying: true, sellingZone: true,
  performanceZone: true, supervisorZone: true
};
let _features = { ...FEATURES_DEFAULT };
try { _features = { ...FEATURES_DEFAULT, ...JSON.parse(fs.readFileSync(FEATURES_PATH, 'utf8')) }; } catch(_) {}

async function atFetch(endpoint, options = {}) {
  const url = `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json', ...options.headers }
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `Airtable ${res.status}`);
  return body;
}

function recordToUser(record) {
  const f = record.fields;
  return {
    id: record.id,
    email:     f[F_EMAIL]    || '',
    salutation:f[F_SAL]      || '',
    firstName: f[F_FIRST]    || '',
    lastName:  f[F_LAST]     || '',
    jobTitle:  f[F_TITLE]    || '',
    mobile:    f[F_MOBILE]   || '',
    landline:  f[F_LANDLINE] || '',
    website:   f[F_WEBSITE]  || '',
    isAdmin:          f[F_ADMIN]       || false,
    sellsMortgages:   f[F_MORTGAGES]        || false,
    sellsProtection:  f[F_PROTECTION]       || false,
    sellsInvestments: f[F_INVESTMENTS]      || false,
    isSupervisor:     f[F_IS_SUPERVISOR]    || false,
    supervisorEmail:  f[F_SUPERVISOR_EMAIL] || '',
    avatarUrl:        f[F_AVATAR]           || '',
    isMarketing:      _marketingUsers.has((f[F_EMAIL] || '').toLowerCase()),
    ...getExtraProducts(f[F_EMAIL] || '')
  };
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);
app.use(session({
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true } // 1 week
}));

// ── Auth guards ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.session.authenticated) return res.status(403).json({ error: 'Forbidden' });
  // Allow if current user is admin, OR if impersonating and original user was admin
  const u = req.session.user;
  const orig = req.session.originalUser;
  if (u && u.isAdmin) return next();
  if (orig && orig.isAdmin) return next(); // admin in Guardian Mode
  res.status(403).json({ error: 'Forbidden' });
}

// Admins + supervisors (and their Guardian Mode sessions) can manage users
function requireAdminOrSupervisor(req, res, next) {
  if (!req.session.authenticated) return res.status(403).json({ error: 'Forbidden' });
  const u = req.session.user;
  const orig = req.session.originalUser;
  const effective = orig || u; // in Guardian Mode, check original identity
  if (effective && (effective.isAdmin || effective.isSupervisor)) return next();
  res.status(403).json({ error: 'Forbidden' });
}

function requireMarketingOrAdmin(req, res, next) {
  if (!req.session.authenticated) return res.status(403).json({ error: 'Forbidden' });
  const u = req.session.user;
  const orig = req.session.originalUser;
  if (u && (u.isAdmin || u.isMarketing)) return next();
  if (orig && (orig.isAdmin || orig.isMarketing)) return next(); // impersonating
  res.status(403).json({ error: 'Forbidden' });
}


// ── Serve static assets (only after auth) ───────────────────
// Public assets are gated — we serve them via a route, not express.static
app.use('/static', express.static(path.join(__dirname, 'public/static')));

// ── Newsletters (auth-gated PDF + cover serving) ────────────
app.use('/newsletters', requireAuth, express.static(path.join(__dirname, 'public/newsletters')));

// ── Newsletter upload (supervisor/admin only) ─────────────────
app.post('/api/newsletters/upload', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (!user.isSupervisor && !user.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const { month, year, data } = req.body; // data = base64 PDF string
  if (!month || !year || !data) return res.status(400).json({ error: 'Missing fields' });
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const mon = MONTHS[parseInt(month) - 1];
  if (!mon) return res.status(400).json({ error: 'Invalid month' });
  const filename = mon + '-' + year + '.pdf';
  const dest = path.join(__dirname, 'public/newsletters', filename);
  try {
    const buf = Buffer.from(data, 'base64');
    if (buf.length > 20_000_000) return res.status(400).json({ error: 'File too large (max 20MB)' });
    require('fs').writeFileSync(dest, buf);
    res.json({ ok: true, filename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Surveying Airtable ────────────────────────────────────────
const SV_BASE = 'appTQIvpD5TBphlq4';
const SV_LEADS_TABLE = 'tblhGuMyeR3zPBJXe';
const SV_SALES_TABLE = 'tbl52e6VsmaJny9f3';

async function svFetch(table, qs) {
  const url = `https://api.airtable.com/v0/${SV_BASE}/${table}${qs}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' }
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `Airtable ${res.status}`);
  return body;
}

app.get('/api/surveying/leads', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    const formula = encodeURIComponent(`FIND("${name}", {Introducer})`);
    const fieldQs = ['Customer Name','Postcode','Date','Introducer','Status','Quotation','Acre reference','Valuation']
      .map(f => `fields[]=${encodeURIComponent(f)}`).join('&');
    const allRecords = [];
    let offset = '';
    do {
      const qs = `?filterByFormula=${formula}&${fieldQs}&sort[0][field]=Date&sort[0][direction]=desc${offset ? '&offset=' + offset : ''}`;
      const data = await svFetch(SV_LEADS_TABLE, qs);
      for (const r of (data.records || [])) allRecords.push(r);
      offset = data.offset || '';
    } while (offset);
    res.json(allRecords.map(r => ({
      id: r.id,
      name:       r.fields['Customer Name'] || '',
      postcode:   r.fields['Postcode'] || '',
      date:       r.fields['Date'] || '',
      introducer: r.fields['Introducer'] || '',
      status:     r.fields['Status'] ? (r.fields['Status'].name || r.fields['Status']) : '',
      quotation:  r.fields['Quotation'] || 0,
      acreRef:    r.fields['Acre reference'] || '',
      valuation:  r.fields['Valuation'] || 0
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/surveying/sales', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    const formula = encodeURIComponent(`FIND("${name}", {Referred by name})`);
    const fieldQs = ['Address','Date','Broker Status','Broker fee','Completed','Referred by name','Referred by firm','Acre reference']
      .map(f => `fields[]=${encodeURIComponent(f)}`).join('&');
    const allRecords = [];
    let offset = '';
    do {
      const qs = `?filterByFormula=${formula}&${fieldQs}&sort[0][field]=Date&sort[0][direction]=desc${offset ? '&offset=' + offset : ''}`;
      const data = await svFetch(SV_SALES_TABLE, qs);
      for (const r of (data.records || [])) allRecords.push(r);
      offset = data.offset || '';
    } while (offset);
    res.json(allRecords.map(r => ({
      id: r.id,
      address:   r.fields['Address'] || '',
      date:      r.fields['Date'] || '',
      status:    r.fields['Broker Status'] ? (r.fields['Broker Status'].name || r.fields['Broker Status']) : '',
      paid:      r.fields['Paid'] || '',
      fee:       r.fields['Broker fee'] || 0,
      firm:      r.fields['Referred by firm'] || '',
      acreRef:   r.fields['Acre reference'] || '',
      completed: r.fields['Completed'] || ''
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Newsletter list API ───────────────────────────────────────
app.get('/api/newsletters', requireAuth, (req, res) => {
  const dir = path.join(__dirname, 'public/newsletters');
  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const MONTH_NAMES = { jan:'January',feb:'February',mar:'March',apr:'April',may:'May',jun:'June',
                        jul:'July',aug:'August',sep:'September',oct:'October',nov:'November',dec:'December' };
  try {
    const files = require('fs').readdirSync(dir)
      .filter(f => f.endsWith('.pdf') && /^[a-z]{3}-\d{4}\.pdf$/.test(f))
      .map(f => {
        const [mon, yr] = f.replace('.pdf','').split('-');
        return { file: f, mon, year: parseInt(yr), monthNum: MONTHS[mon] || 0, label: MONTH_NAMES[mon] + ' ' + yr };
      })
      .sort((a, b) => b.year - a.year || b.monthNum - a.monthNum);
    res.json(files);
  } catch(e) { res.json([]); }
});

// ── Public logo (for display only) ──────────────────────────
app.get('/public-logo', (req, res) => {
  const p = require('path').join(__dirname, 'public/assets/logos/web/FPG-Logo-Transparent.png');
  if (require('fs').existsSync(p)) res.sendFile(p);
  else res.status(404).send('Not found');
});
app.get('/public-feefo-logo', (req, res) => {
  const p = path.join(__dirname, 'public/feefo.png');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Not found');
});

// ── Login routes ─────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.redirect('/login?error=1');
  const emailLower = email.trim().toLowerCase();

  // Check lockout
  const lockStatus = getLoginLockStatus(emailLower);
  if (lockStatus.locked) return res.redirect('/login?locked=1&mins=' + lockStatus.minsLeft);

  try {
    const formula = encodeURIComponent(`{Email}="${emailLower}"`);
    const data = await atFetch(`?filterByFormula=${formula}&returnFieldsByFieldId=true`);
    if (!data.records || data.records.length === 0) {
      recordFailedLogin(emailLower);
      const ls = getLoginLockStatus(emailLower);
      return ls.locked
        ? res.redirect('/login?locked=1&mins=' + ls.minsLeft)
        : res.redirect('/login?error=1&left=' + ls.attemptsLeft);
    }
    const record = data.records[0];
    const hash = record.fields[F_PASSWORD];
    if (!hash || !bcrypt.compareSync(password, hash)) {
      recordFailedLogin(emailLower);
      const ls = getLoginLockStatus(emailLower);
      return ls.locked
        ? res.redirect('/login?locked=1&mins=' + ls.minsLeft)
        : res.redirect('/login?error=1&left=' + ls.attemptsLeft);
    }
    clearLoginAttempts(emailLower);
    req.session.authenticated = true;
    req.session.user = recordToUser(record);
    res.redirect('/');
  } catch (err) {
    console.error('Login error:', err);
    res.redirect('/login?error=1');
  }
});

// ── Forgot password ───────────────────────────────────────────────
app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/forgot-password.html'));
});

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const emailLower = email.trim().toLowerCase();
  try {
    const formula = encodeURIComponent(`{Email}="${emailLower}"`);
    const data = await atFetch(`?filterByFormula=${formula}&returnFieldsByFieldId=true`);
    if (!data.records || data.records.length === 0) {
      // Don't reveal whether email exists
      return res.json({ ok: true });
    }
    const record = data.records[0];
    const user   = recordToUser(record);
    const token  = createResetToken(emailLower);
    const name   = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'there';
    const resetUrl = (process.env.APP_URL || 'https://dam.simflex.ai') + '/reset-password?token=' + token;
    const fromEmail = process.env.CM_FROM_EMAIL || 'noreply@financeplanning.co.uk';
    await _mailer.sendMail({
      from: `"Finance Planning Group" <${fromEmail}>`,
      to: emailLower,
      subject: 'Reset your FPG Knowledge Hub password',
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
        <img src="https://dam.simflex.ai/public-logo" alt="FPG" style="height:48px;margin-bottom:24px;">
        <h2 style="color:#003768;margin:0 0 12px;">Password reset request</h2>
        <p style="color:#4a5a6a;line-height:1.6;">Hi ${name},<br><br>We received a request to reset your password. Click the button below — this link is valid for <strong>1 hour</strong>.</p>
        <a href="${resetUrl}" style="display:inline-block;margin:20px 0;background:#003768;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">Reset Password</a>
        <p style="color:#6b7c8f;font-size:13px;">If you didn't request this, you can safely ignore this email. Your password will not change.</p>
        <hr style="border:none;border-top:1px solid #e8ecf0;margin:24px 0;">
        <p style="color:#6b7c8f;font-size:12px;">Finance Planning Group · FPG Knowledge Hub</p>
      </div>`
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Could not send reset email' });
  }
});

// ── Reset password page ───────────────────────────────────────────
app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/reset-password.html'));
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 6) {
    return res.status(400).json({ error: 'Token and password (min 6 chars) required' });
  }
  const email = consumeResetToken(token);
  if (!email) return res.status(400).json({ error: 'Reset link has expired or is invalid' });
  try {
    const formula = encodeURIComponent(`{Email}="${email}"`);
    const data = await atFetch(`?filterByFormula=${formula}&returnFieldsByFieldId=true`);
    if (!data.records || data.records.length === 0) return res.status(404).json({ error: 'Account not found' });
    const record = data.records[0];
    const hash = bcrypt.hashSync(password, 10);
    await atFetch(`/${record.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { [F_PASSWORD]: hash }, returnFieldsByFieldId: true })
    });
    clearLoginAttempts(email);
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Could not reset password' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── Current user ─────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ...(req.session.user || {}), _impersonating: req.session.impersonating || false });
});

// ── Profile: current user self-edit ──────────────────────────
app.put('/api/profile', requireAuth, async (req, res) => {
  const { salutation, firstName, lastName, jobTitle, mobile, landline, website, password } = req.body;
  const id = req.session.user.id;
  try {
    const fields = {
      [F_SAL]:      salutation || null,
      [F_FIRST]:    firstName  || '',
      [F_LAST]:     lastName   || '',
      [F_TITLE]:    jobTitle   || '',
      [F_MOBILE]:   mobile     || '',
      [F_LANDLINE]: landline   || '',
      [F_WEBSITE]:  website    || null
    };
    if (password) fields[F_PASSWORD] = bcrypt.hashSync(password, 10);
    const data = await atFetch(`/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields, returnFieldsByFieldId: true })
    });
    const updated = recordToUser(data);
    // Refresh session
    req.session.user = { ...req.session.user, ...updated };
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Profile: upload photo (base64 data URL) ───────────────────
app.post('/api/profile/photo', requireAuth, async (req, res) => {
  const { dataUrl } = req.body;
  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid image data' });
  }
  // Limit to ~2MB base64
  if (dataUrl.length > 2_800_000) {
    return res.status(400).json({ error: 'Image too large (max ~2MB)' });
  }
  const id = req.session.user.id;
  try {
    const data = await atFetch(`/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { [F_AVATAR]: dataUrl }, returnFieldsByFieldId: true })
    });
    const updated = recordToUser(data);
    req.session.user = { ...req.session.user, ...updated };
    res.json({ avatarUrl: updated.avatarUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: list users ─────────────────────────────────────────
app.get('/api/admin/users', requireAdminOrSupervisor, async (req, res) => {
  try {
    const users = [];
    let offset = '';
    do {
      const qs = `?returnFieldsByFieldId=true&pageSize=50${offset ? '&offset=' + offset : ''}`;
      const data = await atFetch(qs);
      for (const r of (data.records || [])) {
        const u = recordToUser(r);
        u.hasPassword = !!r.fields[F_PASSWORD];
        users.push(u);
      }
      offset = data.offset || '';
    } while (offset);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: create user ────────────────────────────────────────
app.post('/api/admin/users', requireAdminOrSupervisor, async (req, res) => {
  const { email, password, salutation, firstName, lastName, jobTitle, mobile, landline, website, isAdmin, isMarketing, sellsMortgages, sellsProtection, sellsInvestments, isSupervisor, supervisorEmail } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  // Supervisors cannot create admin users
  const actingUser = req.session.originalUser || req.session.user;
  if (!actingUser.isAdmin && (isAdmin === true || isAdmin === 'true')) {
    return res.status(403).json({ error: 'Only admins can grant admin access' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const normEmail = email.trim().toLowerCase();
    const fields = {
      [F_EMAIL]:       normEmail,
      [F_PASSWORD]:    hash,
      [F_SAL]:         salutation  || null,
      [F_FIRST]:       firstName   || '',
      [F_LAST]:        lastName    || '',
      [F_TITLE]:       jobTitle    || '',
      [F_MOBILE]:      mobile      || '',
      [F_LANDLINE]:    landline    || '',
      [F_WEBSITE]:     website     || null,
      [F_ADMIN]:            isAdmin      === true || isAdmin      === 'true',
      [F_MORTGAGES]:        sellsMortgages   === true || sellsMortgages   === 'true',
      [F_PROTECTION]:       sellsProtection  === true || sellsProtection  === 'true',
      [F_INVESTMENTS]:      sellsInvestments === true || sellsInvestments === 'true',
      [F_IS_SUPERVISOR]:    isSupervisor === true || isSupervisor === 'true',
      [F_SUPERVISOR_EMAIL]: supervisorEmail  || null
    };
    const data = await atFetch('', {
      method: 'POST',
      body: JSON.stringify({ records: [{ fields }], returnFieldsByFieldId: true })
    });
    // Handle marketing role
    const mktFlag = isMarketing === true || isMarketing === 'true';
    if (mktFlag) _marketingUsers.add(normEmail);
    else _marketingUsers.delete(normEmail);
    fs.writeFileSync(MARKETING_USERS_PATH, JSON.stringify([..._marketingUsers], null, 2));
    // Handle extra products
    _extraProducts[normEmail] = {
      equityRelease:       req.body.equityRelease       === true || req.body.equityRelease       === 'true',
      commercialMortgages: req.body.commercialMortgages === true || req.body.commercialMortgages === 'true'
    };
    saveExtraProducts();
    res.json(recordToUser(data.records[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: bulk import users ──────────────────────────────────
app.post('/api/admin/users/bulk', requireAdmin, async (req, res) => {
  const users = req.body;
  if (!Array.isArray(users) || users.length === 0)
    return res.status(400).json({ error: 'Expected array of users' });

  const results = { created: 0, skipped: 0, errors: [] };
  const toBool = v => v === true || v === 'true' || v === 'TRUE';
  const BATCH = 10;

  // Hash all passwords async (parallel within each batch)
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH).filter(u => u.email && u.password);
    if (!batch.length) { results.skipped += BATCH; continue; }

    let records;
    try {
      records = await Promise.all(batch.map(async u => {
        const hash = await bcrypt.hash(String(u.password), 10);
        return { fields: {
          [F_EMAIL]:            String(u.email).trim().toLowerCase(),
          [F_PASSWORD]:         hash,
          [F_SAL]:              u.salutation  || null,
          [F_FIRST]:            u.firstName   || '',
          [F_LAST]:             u.lastName    || '',
          [F_TITLE]:            u.jobTitle    || null,
          [F_MOBILE]:           u.mobile      || '',
          [F_LANDLINE]:         u.landline    || '',
          [F_WEBSITE]:          u.website     || null,
          [F_ADMIN]:            toBool(u.isAdmin),
          [F_MORTGAGES]:        toBool(u.sellsMortgages),
          [F_PROTECTION]:       toBool(u.sellsProtection),
          [F_INVESTMENTS]:      toBool(u.sellsInvestments),
          [F_IS_SUPERVISOR]:    toBool(u.isSupervisor),
          [F_SUPERVISOR_EMAIL]: u.supervisorEmail || null
        }};
      }));
    } catch (e) {
      results.errors.push({ batch: i, error: 'hash error: ' + e.message });
      continue;
    }

    try {
      const data = await atFetch('', {
        method: 'POST',
        body: JSON.stringify({ records, returnFieldsByFieldId: true })
      });
      results.created += (data.records || []).length;
    } catch (e) {
      results.errors.push({ batch: i, error: e.message });
    }
    // Respect Airtable rate limit (5 req/s)
    await new Promise(r => setTimeout(r, 300));
  }

  res.json(results);
});

// ── Admin: update user ────────────────────────────────────────
app.put('/api/admin/users/:id', requireAdminOrSupervisor, async (req, res) => {
  const { id } = req.params;
  const { password, salutation, firstName, lastName, jobTitle, mobile, landline, website, isAdmin, isMarketing, sellsMortgages, sellsProtection, sellsInvestments, isSupervisor, supervisorEmail, email } = req.body;
  // Supervisors cannot edit admin users or grant admin access
  const actingUser = req.session.originalUser || req.session.user;
  if (!actingUser.isAdmin) {
    // Fetch target to check if they are admin
    try {
      const targetRecord = await atFetch(`/${id}?returnFieldsByFieldId=true`);
      const target = recordToUser(targetRecord);
      if (target.isAdmin) return res.status(403).json({ error: 'Supervisors cannot edit admin users' });
    } catch(e) { return res.status(500).json({ error: e.message }); }
    if (isAdmin === true || isAdmin === 'true') {
      return res.status(403).json({ error: 'Only admins can grant admin access' });
    }
  }
  try {
    const fields = {
      [F_SAL]:              salutation  || null,
      [F_FIRST]:            firstName   || '',
      [F_LAST]:             lastName    || '',
      [F_TITLE]:            jobTitle    || '',
      [F_MOBILE]:           mobile      || '',
      [F_LANDLINE]:         landline    || '',
      [F_WEBSITE]:          website     || null,
      [F_ADMIN]:            isAdmin      === true || isAdmin      === 'true',
      [F_MORTGAGES]:        sellsMortgages   === true || sellsMortgages   === 'true',
      [F_PROTECTION]:       sellsProtection  === true || sellsProtection  === 'true',
      [F_INVESTMENTS]:      sellsInvestments === true || sellsInvestments === 'true',
      [F_IS_SUPERVISOR]:    isSupervisor === true || isSupervisor === 'true',
      [F_SUPERVISOR_EMAIL]: supervisorEmail  || null
    };
    if (password) fields[F_PASSWORD] = bcrypt.hashSync(password, 10);
    const data = await atFetch(`/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields, returnFieldsByFieldId: true })
    });
    // Handle marketing role + extra products (keyed by email)
    if (email !== undefined) {
      const normEmail = email.trim().toLowerCase();
      const mktFlag = isMarketing === true || isMarketing === 'true';
      if (mktFlag) _marketingUsers.add(normEmail);
      else _marketingUsers.delete(normEmail);
      fs.writeFileSync(MARKETING_USERS_PATH, JSON.stringify([..._marketingUsers], null, 2));
      _extraProducts[normEmail] = {
        equityRelease:       req.body.equityRelease       === true || req.body.equityRelease       === 'true',
        commercialMortgages: req.body.commercialMortgages === true || req.body.commercialMortgages === 'true'
      };
      saveExtraProducts();
    }
    res.json(recordToUser(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: delete user ────────────────────────────────────────
app.delete('/api/admin/users/:id', requireAdminOrSupervisor, async (req, res) => {
  try {
    const actingUser = req.session.originalUser || req.session.user;
    if (!actingUser.isAdmin) {
      const targetRecord = await atFetch(`/${req.params.id}?returnFieldsByFieldId=true`);
      const target = recordToUser(targetRecord);
      if (target.isAdmin) return res.status(403).json({ error: 'Supervisors cannot delete admin users' });
    }
    await atFetch(`/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: impersonate a user ─────────────────────────────────
app.post('/api/admin/impersonate', requireAdminOrSupervisor, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing user id' });
    // Fetch the target user's record
    const record = await atFetch(`/${id}?returnFieldsByFieldId=true`);
    const target = recordToUser(record);
    // Store original admin session so they can return
    if (!req.session.impersonating) {
      req.session.originalUser = req.session.user;
    }
    req.session.user = target;
    req.session.impersonating = true;
    req.session.save(() => res.json({ ok: true }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/impersonate/stop', requireAuth, (req, res) => {
  if (!req.session.impersonating) return res.json({ ok: true });
  req.session.user = req.session.originalUser;
  delete req.session.impersonating;
  delete req.session.originalUser;
  req.session.save(() => res.json({ ok: true }));
});

// ── PZ: broker → supervisor name map ──────────────────────────
app.get('/api/pz/supervisor-map', requireAuth, async (req, res) => {
  try {
    const allUsers = [];
    let offset = '';
    do {
      const qs = `?returnFieldsByFieldId=true&pageSize=100${offset ? '&offset=' + offset : ''}`;
      const data = await atFetch(qs);
      for (const r of (data.records || [])) allUsers.push(recordToUser(r));
      offset = data.offset || '';
    } while (offset);
    // Build email → fullName lookup
    const emailToName = {};
    for (const u of allUsers) {
      const n = [u.firstName, u.lastName].filter(Boolean).join(' ');
      if (u.email) emailToName[u.email.toLowerCase()] = n || u.email;
    }
    // Build brokerName → supervisorName
    const map = {};
    for (const u of allUsers) {
      const n = [u.firstName, u.lastName].filter(Boolean).join(' ');
      if (!n) continue;
      const supEmail = (u.supervisorEmail || '').toLowerCase();
      map[n] = supEmail ? (emailToName[supEmail] || 'Other') : 'Management';
    }
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Supervisor: list all supervisors (for transfer dropdown) ──
app.get('/api/supervisor/list', requireAuth, async (req, res) => {
  try {
    const supervisors = [];
    const seen = new Set();
    let offset = '';
    do {
      const qs = `?returnFieldsByFieldId=true&pageSize=50${offset ? '&offset=' + offset : ''}`;
      const data = await atFetch(qs);
      for (const r of (data.records || [])) {
        if (!r.fields[F_IS_SUPERVISOR]) continue;
        const u = recordToUser(r);
        if (seen.has(u.email)) continue;
        seen.add(u.email);
        supervisors.push({ id: u.id, email: u.email, name: ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) });
      }
      offset = data.offset || '';
    } while (offset);
    supervisors.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ supervisors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Supervisor: CPD drill-down for one adviser ─────────────────
app.get('/api/supervisor/adviser-cpd', requireAuth, async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const thisYear = new Date().getFullYear();
    const startOfYear = `${thisYear}-01-01`;
    const formula = encodeURIComponent(`AND({User Email}="${email}",IS_AFTER({Date},"${startOfYear}"))`);
    const data = await cpdFetch(`?filterByFormula=${formula}&sort[0][field]=${CPD_DATE}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=50`);
    const entries = (data.records || []).map(cpdRecordToEntry);
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Supervisor: transfer adviser to another supervisor ─────────
app.put('/api/supervisor/transfer', requireAuth, async (req, res) => {
  const { adviserEmail, newSupervisorEmail } = req.body;
  if (!adviserEmail || !newSupervisorEmail) return res.status(400).json({ error: 'adviserEmail and newSupervisorEmail required' });
  try {
    // Find the adviser record
    const formula = encodeURIComponent(`{Email}="${adviserEmail}"`);
    const data = await atFetch(`?filterByFormula=${formula}&returnFieldsByFieldId=true`);
    if (!data.records || !data.records.length) return res.status(404).json({ error: 'Adviser not found' });
    const recordId = data.records[0].id;
    await atFetch(`/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { [F_SUPERVISOR_EMAIL]: newSupervisorEmail }, returnFieldsByFieldId: true })
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Supervisor: team CPD dashboard ────────────────────────────
app.get('/api/supervisor/team', requireAuth, async (req, res) => {
  const isAdmin = req.session.user.isAdmin;
  // ?as=all → whole company (admin only); ?as=email → specific supervisor
  let supervisorEmail = req.session.user.email;
  let viewAll = false;
  if (req.query.as === 'all' && isAdmin) {
    viewAll = true;
  } else if (req.query.as && (isAdmin || req.session.user.isSupervisor)) {
    supervisorEmail = req.query.as;
  } else if (isAdmin && !req.query.as) {
    // Admins default to whole-company view
    viewAll = true;
  }
  try {
    // 1. Get team members — paginate through all users
    const allRecords = [];
    let teamOffset = '';
    do {
      const qs = `?returnFieldsByFieldId=true&pageSize=50${teamOffset ? '&offset=' + teamOffset : ''}`;
      const page = await atFetch(qs);
      allRecords.push(...(page.records || []));
      teamOffset = page.offset || '';
    } while (teamOffset);
    let lookupEmail = supervisorEmail;
    if (!viewAll) {
      // Check if this supervisor has a "Co-supervises Email" set — if so, show that team instead
      const svRecord = allRecords.find(r =>
        (r.fields[F_EMAIL] || '').toLowerCase() === supervisorEmail.toLowerCase()
      );
      const coEmail = svRecord?.fields[F_CO_SUPERVISES];
      if (coEmail) lookupEmail = coEmail.toLowerCase();
    }

    const members = allRecords
      .filter(r => {
        if (viewAll) return true; // everyone including admins
        return (r.fields[F_SUPERVISOR_EMAIL] || '').toLowerCase() === lookupEmail.toLowerCase();
      })
      .map(r => {
        const u = recordToUser(r);
        u.hasPassword = !!r.fields[F_PASSWORD];
        return u;
      });

    if (!members.length) return res.json({ members: [], cpdByMember: {} });

    // 2. Fetch this year's CPD entries for all team members in one query
    const thisYear = new Date().getFullYear();
    const startOfYear = `${thisYear}-01-01`;
    const emails = members.map(m => `{User Email}="${m.email}"`).join(',');
    const cpdFormula = encodeURIComponent(`AND(OR(${emails}),IS_AFTER({Date},"${startOfYear}"))`);
    const cpdData = await cpdFetch(`?filterByFormula=${cpdFormula}&returnFieldsByFieldId=true&pageSize=50`);
    const allEntries = (cpdData.records || []).map(cpdRecordToEntry);

    // 3. Aggregate per member per CPD type
    const cpdByMember = {};
    members.forEach(m => { cpdByMember[m.email] = { Investment: 0, Mortgage: 0, Protection: 0, total: 0 }; });
    allEntries.forEach(e => {
      if (!cpdByMember[e.email]) return;
      cpdByMember[e.email].total += e.minutes || 0;
      if (e.cpdType && cpdByMember[e.email][e.cpdType] !== undefined) {
        cpdByMember[e.email][e.cpdType] += e.minutes || 0;
      }
    });

    res.json({ members, cpdByMember, targets: CPD_TARGETS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Supervisor: export team CPD as CSV ───────────────────────
app.get('/api/supervisor/export-csv', requireAuth, async (req, res) => {
  const from        = req.query.from  || `${new Date().getFullYear()}-01-01`;
  const to          = req.query.to    || new Date().toISOString().slice(0, 10);
  const singleEmail = req.query.email || null;  // broker-level export
  const exportAll   = req.query.all === 'true' && (req.session.user.isAdmin || req.session.user.isSupervisor);

  try {
    const esc = v => '"' + String(v || '').replace(/"/g, '""') + '"';

    // ── Single broker export ──────────────────────────────────
    if (singleEmail) {
      const formula = encodeURIComponent(
        `AND({User Email}="${singleEmail}",IS_AFTER({Date},"${from}"),NOT(IS_AFTER({Date},"${to}")))`
      );
      const cpdData = await cpdFetch(`?filterByFormula=${formula}&sort[0][field]=${CPD_DATE}&sort[0][direction]=asc&returnFieldsByFieldId=true&pageSize=50`);
      const entries = (cpdData.records || []).map(cpdRecordToEntry);
      const rows = [['Name', 'Email', 'Date', 'CPD Type', 'Activity', 'Minutes', 'Hours', 'What I Learned'].map(esc).join(',')];
      entries.forEach(e => {
        rows.push([e.email, e.email, e.date || '', e.cpdType || '', e.title || '', e.minutes || 0, ((e.minutes || 0) / 60).toFixed(2), e.learned || ''].map(esc).join(','));
      });
      const safeName = singleEmail.replace(/[^a-z0-9]/gi, '-');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-cpd-${from}-to-${to}.csv"`);
      return res.send(rows.join('\r\n'));
    }

    // ── Whole company or supervisor team export ───────────────
    const allExportRecords = [];
    let expOffset = '';
    do {
      const qs = `?returnFieldsByFieldId=true&pageSize=50${expOffset ? '&offset=' + expOffset : ''}`;
      const page = await atFetch(qs);
      allExportRecords.push(...(page.records || []));
      expOffset = page.offset || '';
    } while (expOffset);
    let members;
    if (exportAll) {
      members = allExportRecords.map(r => recordToUser(r));
    } else {
      let supervisorEmail = req.session.user.email;
      if (req.query.as && (req.session.user.isAdmin || req.session.user.isSupervisor)) supervisorEmail = req.query.as;
      members = allExportRecords
        .filter(r => (r.fields[F_SUPERVISOR_EMAIL] || '').toLowerCase() === supervisorEmail.toLowerCase())
        .map(r => recordToUser(r));
    }
    if (!members.length) {
      res.setHeader('Content-Type', 'text/csv');
      return res.send('No members found');
    }
    const emails  = members.map(m => `{User Email}="${m.email}"`).join(',');
    const formula = encodeURIComponent(
      `AND(OR(${emails}),IS_AFTER({Date},"${from}"),NOT(IS_AFTER({Date},"${to}")))`
    );
    const cpdData = await cpdFetch(`?filterByFormula=${formula}&sort[0][field]=${CPD_DATE}&sort[0][direction]=asc&returnFieldsByFieldId=true&pageSize=50`);
    const entries = (cpdData.records || []).map(cpdRecordToEntry);
    const memberMap = {};
    members.forEach(m => { memberMap[m.email] = m; });
    const rows = [['Name', 'Email', 'Date', 'CPD Type', 'Activity', 'Minutes', 'Hours', 'What I Learned'].map(esc).join(',')];
    entries.forEach(e => {
      const m = memberMap[e.email] || {};
      const name = [m.salutation, m.firstName, m.lastName].filter(Boolean).join(' ') || e.email;
      rows.push([name, e.email, e.date || '', e.cpdType || '', e.title || '', e.minutes || 0, ((e.minutes || 0) / 60).toFixed(2), e.learned || ''].map(esc).join(','));
    });
    const label = exportAll ? 'company' : 'team';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${label}-cpd-${from}-to-${to}.csv"`);
    res.send(rows.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Learning zone config ──────────────────────────────────────
const LV_TABLE    = 'tblGxOMw9SDUlzw1h';
const LV_TITLE    = 'fldTYb4MSVDqIdr85';
const LV_DESC     = 'fldAdn5cQl5CDKJF4';
const LV_URL      = 'fldebTNSnIADrx4jv';
const LV_ADDED    = 'fldBykZ17cGbybYAp';
const LV_CPD_TYPE = 'fldQoRx2AsSvTdwY6';
const FEATURED_COUNT = 8;

async function lvFetch(endpoint, options = {}) {
  const url = `https://api.airtable.com/v0/${AT_BASE}/${LV_TABLE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json', ...options.headers }
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `Airtable ${res.status}`);
  return body;
}

function lvRecordToVideo(record) {
  const f = record.fields;
  return {
    id:          record.id,
    title:       f[LV_TITLE]    || '',
    description: f[LV_DESC]    || '',
    url:         f[LV_URL]     || '',
    added:       f[LV_ADDED]   || record.createdTime || '',
    cpdType:     f[LV_CPD_TYPE]|| 'Mortgage'
  };
}

// GET /api/learning — featured 8 + archive (auth required)
// GET /api/learning/catch-up?type=Mortgage — 3 most recent videos of a CPD type
app.get('/api/learning/catch-up', requireAuth, async (req, res) => {
  const type = req.query.type;
  if (!type) return res.status(400).json({ error: 'type required' });
  try {
    // Blank CPD type defaults to Mortgage, so include empty fields when filtering for Mortgage
    const typeFilter = type === 'Mortgage'
      ? `OR({${LV_CPD_TYPE}} = "Mortgage", {${LV_CPD_TYPE}} = "")`
      : `{${LV_CPD_TYPE}} = "${type}"`;
    const formula = encodeURIComponent(typeFilter);
    const data = await lvFetch(`?filterByFormula=${formula}&sort[0][field]=${LV_ADDED}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=3`);
    res.json({ videos: (data.records || []).map(lvRecordToVideo) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/learning', requireAuth, async (req, res) => {
  try {
    const data = await lvFetch(`?sort[0][field]=${LV_ADDED}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=50`);
    const all = (data.records || []).map(lvRecordToVideo);
    res.json({ featured: all.slice(0, FEATURED_COUNT), archive: all.slice(FEATURED_COUNT) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/learning — add video
app.post('/api/admin/learning', requireAdmin, async (req, res) => {
  const { title, description, url, cpdType } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'Title and URL required' });
  try {
    const data = await lvFetch('', {
      method: 'POST',
      body: JSON.stringify({ records: [{ fields: { [LV_TITLE]: title, [LV_DESC]: description || '', [LV_URL]: url, [LV_ADDED]: new Date().toISOString(), [LV_CPD_TYPE]: cpdType || 'Mortgage' } }], returnFieldsByFieldId: true })
    });
    res.json(lvRecordToVideo(data.records[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/learning/:id — edit video
app.put('/api/admin/learning/:id', requireAdmin, async (req, res) => {
  const { title, description, url, cpdType } = req.body;
  try {
    const data = await lvFetch(`/${req.params.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { [LV_TITLE]: title, [LV_DESC]: description || '', [LV_URL]: url, [LV_CPD_TYPE]: cpdType || 'Mortgage' }, returnFieldsByFieldId: true })
    });
    res.json(lvRecordToVideo(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/learning/:id
app.delete('/api/admin/learning/:id', requireAdmin, async (req, res) => {
  try {
    await lvFetch(`/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CPD Log config ────────────────────────────────────────────
const CPD_TABLE    = 'tblajx6AAKFtI6K1N';
const CPD_ACTIVITY = 'fldE8v8i9jHThIkv3';
const CPD_EMAIL    = 'fldBN8Hh2D7W2JXeV';
const CPD_DATE     = 'fldVe6jUFFO1ZCtk3';
const CPD_MINUTES  = 'fldr6SXrwR1TYnqf8';
const CPD_CATEGORY = 'fldX8oYvUMtCdsXSD';
const CPD_SOURCE   = 'fldSjdFlkizyQVNzP';
const CPD_VTITLE   = 'fldXmHRWv246Wb5FF';
const CPD_TYPE     = 'fldRi9wWzALjvvzu1';
const CPD_LEARNED  = 'flduS7f67tF3W64ZA';
// Per-product CPD targets in minutes: Investment 35hrs, Mortgage 15hrs, Protection 15hrs
const CPD_TARGETS  = { Investment: 2100, Mortgage: 900, Protection: 900 };

async function cpdFetch(endpoint, options = {}) {
  const url = `https://api.airtable.com/v0/${AT_BASE}/${CPD_TABLE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json', ...options.headers }
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `Airtable ${res.status}`);
  return body;
}

function cpdRecordToEntry(record) {
  const f = record.fields;
  return {
    id:         record.id,
    email:      f[CPD_EMAIL]     || '',
    activity:   f[CPD_ACTIVITY]  || '',
    date:       f[CPD_DATE]      || '',
    minutes:    f[CPD_MINUTES]   || 0,
    category:   f[CPD_CATEGORY]  || '',
    source:     f[CPD_SOURCE]    || '',
    videoTitle: f[CPD_VTITLE]    || '',
    cpdType:    f[CPD_TYPE]      || '',
    learned:    f[CPD_LEARNED]   || ''
  };
}

// GET /api/cpd — current user's entries + totals
app.get('/api/cpd', requireAuth, async (req, res) => {
  const email = req.session.user.email;
  try {
    const formula = encodeURIComponent(`{User Email}="${email}"`);
    const data = await cpdFetch(`?filterByFormula=${formula}&sort[0][field]=${CPD_DATE}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=50`);
    const entries = (data.records || []).map(cpdRecordToEntry);
    const totalMins = entries.reduce((sum, e) => sum + (e.minutes || 0), 0);
    // Year-to-date totals — overall and per CPD type
    const thisYear = new Date().getFullYear();
    const ytdEntries = entries.filter(e => e.date && new Date(e.date).getFullYear() === thisYear);
    const ytdMins = ytdEntries.reduce((sum, e) => sum + (e.minutes || 0), 0);
    const byType = { Investment: 0, Mortgage: 0, Protection: 0 };
    ytdEntries.forEach(e => {
      if (e.cpdType && byType[e.cpdType] !== undefined) byType[e.cpdType] += e.minutes || 0;
    });
    res.json({ entries, totalMins, ytdMins, byType, targets: CPD_TARGETS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cpd — manual entry
app.post('/api/cpd', requireAuth, async (req, res) => {
  const { activity, date, minutes, category, cpdType, learned, source } = req.body;
  if (!activity || !date || !minutes) return res.status(400).json({ error: 'Activity, date and minutes required' });
  try {
    const data = await cpdFetch('', {
      method: 'POST',
      body: JSON.stringify({ records: [{ fields: {
        [CPD_ACTIVITY]: activity,
        [CPD_EMAIL]:    req.session.user.email,
        [CPD_DATE]:     date,
        [CPD_MINUTES]:  parseInt(minutes, 10),
        [CPD_CATEGORY]: category || 'Other',
        [CPD_SOURCE]:   source || 'Manual',
        [CPD_TYPE]:     cpdType || 'Mortgage',
        ...(learned ? { [CPD_LEARNED]: learned } : {})
      }}], returnFieldsByFieldId: true })
    });
    res.json(cpdRecordToEntry(data.records[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST /api/test/result — log a knowledge test attempt as CPD
app.post('/api/test/result', requireAuth, async (req, res) => {
  const { testName, score, total, passed, cpdType } = req.body;
  if (!testName || score === undefined || !total) return res.status(400).json({ error: 'Missing fields' });
  const pct = Math.round(score / total * 100);
  const minutes = passed ? 30 : 0;
  const today = new Date().toISOString().split('T')[0];
  try {
    const data = await cpdFetch('', {
      method: 'POST',
      body: JSON.stringify({ records: [{ fields: {
        [CPD_ACTIVITY]: testName + ' – Knowledge Test',
        [CPD_EMAIL]:    req.session.user.email,
        [CPD_DATE]:     today,
        [CPD_MINUTES]:  minutes,
        [CPD_CATEGORY]: 'Technical Knowledge',
        [CPD_SOURCE]:   'Knowledge Test',
        [CPD_TYPE]:     cpdType || 'Mortgage',
        [CPD_LEARNED]:  'Scored ' + score + '/' + total + ' (' + pct + '%) – ' + (passed ? 'PASSED' : 'FAILED')
      }}], returnFieldsByFieldId: true })
    });
    res.json({ ok: true, entry: cpdRecordToEntry(data.records[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cpd/video — auto-log a Learning Zone video (supports 50/50)
app.post('/api/cpd/video', requireAuth, async (req, res) => {
  const { videoTitle, cpdType } = req.body;
  try {
    const today = new Date().toISOString().split('T')[0];
    const makeRecord = (type, mins) => ({ fields: {
      [CPD_ACTIVITY]: videoTitle || 'Learning Zone video',
      [CPD_EMAIL]:    req.session.user.email,
      [CPD_DATE]:     today,
      [CPD_MINUTES]:  mins,
      [CPD_CATEGORY]: 'Technical Knowledge',
      [CPD_SOURCE]:   'Learning Zone',
      [CPD_VTITLE]:   videoTitle || '',
      [CPD_TYPE]:     type
    }});
    const records = cpdType === '50/50'
      ? [makeRecord('Mortgage', 30), makeRecord('Protection', 30)]
      : [makeRecord(cpdType || 'Mortgage', 60)];
    const data = await cpdFetch('', {
      method: 'POST',
      body: JSON.stringify({ records, returnFieldsByFieldId: true })
    });
    res.json((data.records || []).map(cpdRecordToEntry));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/cpd/:id — own entries only
app.delete('/api/cpd/:id', requireAuth, async (req, res) => {
  const email = req.session.user.email;
  try {
    // Verify ownership first
    const record = await cpdFetch(`/${req.params.id}?returnFieldsByFieldId=true`);
    if (record.fields[CPD_EMAIL] !== email) return res.status(403).json({ error: 'Forbidden' });
    await cpdFetch(`/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cpd/pdf — download CPD report as PDF
app.get('/api/cpd/pdf', requireAuth, async (req, res) => {
  const email  = req.session.user.email;
  const period = req.query.period || 'year'; // month | quarter | year
  try {
    // Fetch all entries for user
    const formula = encodeURIComponent(`{User Email}="${email}"`);
    const data = await cpdFetch(`?filterByFormula=${formula}&sort[0][field]=${CPD_DATE}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=50`);
    const allEntries = (data.records || []).map(cpdRecordToEntry);

    // Filter by period
    const now = new Date();
    const entries = allEntries.filter(e => {
      if (!e.date) return false;
      const d = new Date(e.date);
      if (period === 'month')   return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      if (period === 'quarter') { const q = Math.floor(now.getMonth()/3); return d.getFullYear() === now.getFullYear() && Math.floor(d.getMonth()/3) === q; }
      return d.getFullYear() === now.getFullYear();
    });

    const byType = { Mortgage: 0, Protection: 0 };
    entries.forEach(e => { if (e.cpdType && byType[e.cpdType] !== undefined) byType[e.cpdType] += e.minutes || 0; });
    const targets = CPD_TARGETS;

    const user = req.session.user;
    const userName = ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || email;

    // Load fonts and logo
    const fontBoldBytes = fs.readFileSync(path.join(__dirname, 'public/static/fonts/PlusJakartaSans-ExtraBold.ttf'));
    const fontMedBytes  = fs.readFileSync(path.join(__dirname, 'public/static/fonts/PlusJakartaSans-Medium.ttf'));
    const logoBytes     = fs.readFileSync(path.join(__dirname, 'public/assets/logos/web/FPG-Logo-Transparent.png'));

    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const fontBold = await pdfDoc.embedFont(fontBoldBytes);
    const fontMed  = await pdfDoc.embedFont(fontMedBytes);
    const logoImg  = await pdfDoc.embedPng(logoBytes);
    const logoDims = logoImg.scale(0.104); // 0.13 * 0.8

    // Embed adviser photo if available
    let avatarImg = null;
    if (user.avatarUrl && user.avatarUrl.startsWith('data:image/')) {
      try {
        const base64Data = user.avatarUrl.split(',')[1];
        const imgBytes   = Buffer.from(base64Data, 'base64');
        avatarImg = await pdfDoc.embedJpg(imgBytes);
      } catch(_) { avatarImg = null; }
    }

    const W = 595.28, H = 841.89; // A4
    const page = pdfDoc.addPage([W, H]);
    const darkBlue   = rgb(0/255,   55/255,  104/255);
    const accentBlue = rgb(46/255,  153/255, 213/255);
    const amber      = rgb(252/255, 176/255, 52/255);
    const green      = rgb(34/255,  197/255, 94/255);
    const grey       = rgb(107/255, 124/255, 143/255);
    const midGrey    = rgb(160/255, 172/255, 185/255);
    const lightGrey  = rgb(232/255, 236/255, 240/255);
    const pageBg     = rgb(245/255, 247/255, 250/255); // matches #f5f7fa
    const white      = rgb(1, 1, 1);

    const fmtMin = m => { const h = Math.floor(m/60), mn = m%60; return h > 0 ? (h + 'h' + (mn > 0 ? ' ' + mn + 'm' : '')) : (mn + 'm'); };
    const periodTarget = (annual, p) => p === 'month' ? Math.round(annual/12) : p === 'quarter' ? Math.round(annual/4) : annual;
    const periodLabel = period === 'month' ? 'This Month' : period === 'quarter' ? 'This Quarter' : 'This Year';
    const dateStr = now.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });

    // ── Page background ────────────────────────────────────────
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: pageBg });

    // ── Header (white card, full width) ────────────────────────
    const headerH = 76;
    page.drawRectangle({ x: 0, y: H - headerH, width: W, height: headerH, color: white });
    // Logo — top-left with breathing room
    const logoX = 28, logoY = H - headerH + (headerH - logoDims.height) / 2;
    page.drawImage(logoImg, { x: logoX, y: logoY, width: logoDims.width, height: logoDims.height });
    // Adviser photo (circle) + name — right side of header
    const avatarSize = 42;
    const avatarX = W - 28 - avatarSize;
    const avatarY = H - headerH + (headerH - 3 - avatarSize) / 2 + 3;
    if (avatarImg) {
      page.drawImage(avatarImg, { x: avatarX, y: avatarY, width: avatarSize, height: avatarSize });
    }
    const nameX = avatarImg ? avatarX - 10 : W - 28;
    page.drawText(userName, { x: nameX - fontBold.widthOfTextAtSize(userName, 13), y: H - 36, size: 13, font: fontBold, color: darkBlue });
    const subLine = 'CPD Report — ' + periodLabel + '   ·   ' + dateStr;
    page.drawText(subLine, { x: nameX - fontMed.widthOfTextAtSize(subLine, 8), y: H - 52, size: 8, font: fontMed, color: grey });

    let y = H - headerH - 24;

    // ── Progress section ───────────────────────────────────────
    y -= 10;
    page.drawText('CPD Progress', { x: 36, y, size: 11, font: fontBold, color: darkBlue });
    y -= 20;

    const barX = 36, barW = W - 210, barH = 9;
    const drawBar = (label, mins, annualTarget, color) => {
      const target = periodTarget(annualTarget, period);
      const pct = target > 0 ? Math.min(1, mins / target) : 0;
      const done = pct >= 1;
      const barColor = done ? green : color;
      // label
      page.drawText(label, { x: barX, y: y+1, size: 10, font: fontBold, color: darkBlue });
      page.drawText(fmtMin(mins) + ' / ' + fmtMin(target), { x: barX + barW + 12, y: y+1, size: 9, font: fontMed, color: grey });
      y -= 14;
      // track
      page.drawRectangle({ x: barX, y, width: barW, height: barH, color: pageBg, borderRadius: 5 });
      if (pct > 0) page.drawRectangle({ x: barX, y, width: barW * pct, height: barH, color: barColor, borderRadius: 5 });
      y -= 14;
      const pctText = Math.round(pct*100) + '% — ' + (done ? 'Target met ✓' : fmtMin(Math.max(0, target - mins)) + ' remaining');
      page.drawText(pctText, { x: barX, y, size: 8, font: fontMed, color: done ? green : grey });
      y -= 20;
    };

    drawBar('Mortgage CPD',   byType.Mortgage,   targets.Mortgage,   accentBlue);
    drawBar('Protection CPD', byType.Protection, targets.Protection, amber);

    const combMins        = byType.Mortgage + byType.Protection;
    const combAnnualTarget = targets.Mortgage + targets.Protection;
    y -= 4;
    page.drawLine({ start:{x:barX, y:y+16}, end:{x:W-32, y:y+16}, thickness:0.5, color: lightGrey });
    y -= 4;
    drawBar('Combined Total', combMins, combAnnualTarget, darkBlue);

    y -= 16;

    // ── Entries section ────────────────────────────────────────
    y -= 10;
    page.drawText('Entries (' + entries.length + ')', { x: 36, y, size: 11, font: fontBold, color: darkBlue });
    y -= 16;

    // Word-wrap helper
    const wrapText = (text, font, size, maxW) => {
      if (!text) return [];
      const words = text.split(' ');
      const lines = [];
      let line = '';
      words.forEach(w => {
        const test = line ? line + ' ' + w : w;
        if (font.widthOfTextAtSize(test, size) <= maxW) { line = test; }
        else { if (line) lines.push(line); line = w; }
      });
      if (line) lines.push(line);
      return lines;
    };
    const truncate = (s, max) => s && s.length > max ? s.slice(0, max-1) + '…' : (s || '');

    // Table header row
    const cols = [{ x:36, label:'Date' }, { x:114, label:'Activity' }, { x:310, label:'Type' }, { x:398, label:'Category' }, { x:514, label:'Time' }];
    const learnedMaxW = W - 36 - cols[1].x; // full width for learned text
    const learnedLineH = 10;

    const drawTableHeader = (pg, yPos) => {
      pg.drawRectangle({ x: 20, y: yPos - 5, width: W - 40, height: 18, color: pageBg });
      cols.forEach(c => pg.drawText(c.label, { x: c.x, y: yPos + 1, size: 7.5, font: fontBold, color: midGrey }));
    };

    drawTableHeader(page, y);
    y -= 20;

    let currentPage = page;
    entries.forEach((e, i) => {
      // Pre-calculate learned lines
      const learnedLines = e.learned ? wrapText(e.learned, fontMed, 7, learnedMaxW) : [];
      const entryH = 17 + (learnedLines.length > 0 ? 9 + learnedLines.length * learnedLineH : 0);

      // New page if needed
      if (y - entryH < 50) {
        const np = pdfDoc.addPage([W, H]);
        np.drawRectangle({ x: 0, y: 0, width: W, height: H, color: pageBg });
        np.drawRectangle({ x: 0, y: H - headerH, width: W, height: headerH, color: white });
        np.drawImage(logoImg, { x: logoX, y: logoY, width: logoDims.width, height: logoDims.height });
        const contLabel = userName + ' — continued';
        np.drawText(contLabel, { x: W - 28 - fontBold.widthOfTextAtSize(contLabel, 13), y: H - 42, size: 13, font: fontBold, color: darkBlue });
        currentPage = np;
        y = H - headerH - 36;
        drawTableHeader(currentPage, y);
        y -= 20;
      }

      if (i % 2 !== 0) currentPage.drawRectangle({ x: 20, y: y - 5, width: W - 40, height: entryH - 2, color: pageBg });
      const d = e.date ? new Date(e.date).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) : '—';
      currentPage.drawText(d,                        { x: cols[0].x, y, size: 8, font: fontMed,  color: grey });
      currentPage.drawText(truncate(e.activity, 30), { x: cols[1].x, y, size: 8, font: fontBold, color: darkBlue });
      currentPage.drawText(truncate(e.cpdType, 12),  { x: cols[2].x, y, size: 8, font: fontMed,  color: e.cpdType === 'Mortgage' ? accentBlue : amber });
      currentPage.drawText(truncate(e.category, 18), { x: cols[3].x, y, size: 8, font: fontMed,  color: grey });
      currentPage.drawText(fmtMin(e.minutes),        { x: cols[4].x, y, size: 8, font: fontBold, color: darkBlue });
      if (learnedLines.length > 0) {
        y -= 11;
        learnedLines.forEach(line => {
          currentPage.drawText(line, { x: cols[1].x, y, size: 7, font: fontMed, color: midGrey });
          y -= learnedLineH;
        });
        y -= 4;
      } else {
        y -= 17;
      }
    });

    // ── Footer ────────────────────────────────────────────────
    const pages = pdfDoc.getPages();
    pages.forEach((pg, idx) => {
      pg.drawText('Generated by FPG DAM  ·  Page ' + (idx+1) + ' of ' + pages.length, {
        x: 28, y: 16, size: 7, font: fontMed, color: midGrey
      });
    });

    const pdfBytes = await pdfDoc.save();
    const filename = 'CPD-Report-' + periodLabel.replace(/ /g,'-') + '-' + userName.replace(/[^a-z0-9]/gi,'-') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('CPD PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Main app ─────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// ── Video content download ────────────────────────────────────
// Supports both /download-video/folder/file and /download-video/folder/subfolder/file
app.get('/download-video/:post/:sub/:filename', requireAuth, (req, res) => {
  const safePost = req.params.post.replace(/\.\./g, '');
  const safeSub  = req.params.sub.replace(/\.\./g, '');
  const safeFile = path.basename(req.params.filename);
  const filePath = path.join(__dirname, 'public/assets/video-content', safePost, safeSub, safeFile);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath, safeFile);
});
app.get('/download-video/:post/:filename', requireAuth, (req, res) => {
  const safePost = req.params.post.replace(/\.\./g, '');
  const safeFile = path.basename(req.params.filename);
  const filePath = path.join(__dirname, 'public/assets/video-content', safePost, safeFile);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath, safeFile);
});

// ── Video content manifest ────────────────────────────────────
app.get('/api/video-content', requireAuth, (req, res) => {
  const baseDir = path.join(__dirname, 'public/assets/video-content');
  if (!fs.existsSync(baseDir)) return res.json([]);

  function getFiles(dir) {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && fs.statSync(path.join(dir, f)).isFile())
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        return { name: f, created: stat.birthtime || stat.mtime };
      });
  }

  const posts = fs.readdirSync(baseDir)
    .filter(f => !f.startsWith('.') && fs.statSync(path.join(baseDir, f)).isDirectory())
    .sort()
    .map(name => {
      const folderPath = path.join(baseDir, name);
      const subfolders = fs.readdirSync(folderPath)
        .filter(f => !f.startsWith('.') && fs.statSync(path.join(folderPath, f)).isDirectory())
        .sort()
        .map(sub => ({
          name: sub,
          files: getFiles(path.join(folderPath, sub))
        }));
      return {
        name,
        files: getFiles(folderPath),
        subfolders
      };
    });
  res.json(posts);
});

// ── Social content download (nested: /download-post/:post/:filename) ──
app.get('/download-post/:post/:filename', requireAuth, (req, res) => {
  const safePost = req.params.post.replace(/\.\./g, '');
  const safeFile = path.basename(req.params.filename);
  const filePath = path.join(__dirname, 'public/assets/social-content', safePost, safeFile);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath, safeFile);
});

// ── Marketing users management (admin only) ───────────────────
app.get('/api/marketing-users', requireAdmin, (req, res) => {
  res.json([..._marketingUsers]);
});
app.post('/api/marketing-users', requireAdmin, (req, res) => {
  const { email, remove } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const e = email.toLowerCase();
  if (remove) _marketingUsers.delete(e); else _marketingUsers.add(e);
  try {
    fs.writeFileSync(MARKETING_USERS_PATH, JSON.stringify([..._marketingUsers], null, 2));
    // refresh session if this user is logged in
    res.json({ ok: true, marketingUsers: [..._marketingUsers] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Featured social posts ──────────────────────────────────────
app.get('/api/featured-social', requireAuth, (req, res) => {
  res.json(_featuredSocial);
});
app.post('/api/featured-social', requireMarketingOrAdmin, (req, res) => {
  const { title, wording, images, image } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  if (_featuredSocial.length >= 4) return res.status(400).json({ error: 'Maximum 4 featured posts' });
  // Accept either `images` (new per-platform dict) or legacy `image` string
  const post = { id: Date.now().toString(), title, wording: wording || '', images: images || (image ? { Facebook: image } : {}), createdAt: new Date().toISOString() };
  _featuredSocial.push(post);
  try {
    fs.writeFileSync(FEATURED_SOCIAL_PATH, JSON.stringify(_featuredSocial, null, 2));
    res.json({ ok: true, post });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/featured-social/:id', requireMarketingOrAdmin, (req, res) => {
  _featuredSocial = _featuredSocial.filter(p => p.id !== req.params.id);
  try {
    fs.writeFileSync(FEATURED_SOCIAL_PATH, JSON.stringify(_featuredSocial, null, 2));
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/featured-social/:id', requireMarketingOrAdmin, (req, res) => {
  const { title, wording, images, image } = req.body;
  const post = _featuredSocial.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  if (title)   post.title   = title;
  if (wording !== undefined) post.wording = wording;
  if (images)  post.images  = images;
  else if (image) post.images = { Facebook: image }; // legacy compat
  try {
    fs.writeFileSync(FEATURED_SOCIAL_PATH, JSON.stringify(_featuredSocial, null, 2));
    res.json({ ok: true, post });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Share social post via email ───────────────────────────────
app.post('/api/share-social-post', requireAuth, async (req, res) => {
  const { to, postName, wording, images } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });
  if (!process.env.CM_API_KEY) return res.status(503).json({ error: 'Email not configured (CM_API_KEY missing)' });

  const sender = req.session.user;
  const fromName = [sender.firstName, sender.lastName].filter(Boolean).join(' ') || 'Finance Planning Group';
  const fromEmail = process.env.CM_FROM_EMAIL || 'noreply@financeplanning.co.uk';

  // Build attachments from images array [{filename, dataUrl}]
  const attachments = (images || []).map(function(img) {
    const match = (img.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return { filename: img.filename || 'image.jpg', content: Buffer.from(match[2], 'base64'), contentType: match[1] };
  }).filter(Boolean);

  const copyHtml = (wording || '').replace(/\n/g, '<br>');
  const attachNote = attachments.length
    ? `<p style="margin:16px 0 0;font-size:13px;color:#6b7c8f;">📎 ${attachments.length} image${attachments.length > 1 ? 's' : ''} attached (${attachments.map(function(a){ return a.filename; }).join(', ')})</p>`
    : '';

  const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr><td style="background:#003768;padding:24px 32px;">
          <p style="margin:0;color:#fff;font-size:20px;font-weight:700;">Finance Planning Group</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 8px;font-size:13px;color:#6b7c8f;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">SOCIAL POST</p>
          <h2 style="margin:0 0 20px;font-size:22px;color:#003768;">${postName || 'Post'}</h2>
          <div style="background:#f9fafc;border-left:4px solid #003768;border-radius:0 8px 8px 0;padding:16px 20px;margin:0 0 20px;">
            <p style="margin:0;font-size:15px;color:#1a2a3a;line-height:1.6;">${copyHtml}</p>
          </div>
          ${attachNote}
          <p style="margin:24px 0 0;font-size:13px;color:#6b7c8f;">Shared by <strong>${fromName}</strong></p>
        </td></tr>
        <tr><td style="background:#f9fafc;padding:16px 32px;border-top:1px solid #e8ecf0;">
          <p style="margin:0;font-size:11px;color:#9ca8b4;">Finance Planning Group Ltd &mdash; financeplanning.co.uk</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    await _mailer.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject: `Social Post: ${postName || 'Shared post'} — from ${fromName}`,
      html,
      attachments
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Share email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Social copy JSON ──────────────────────────────────────────
app.get('/social-copy.json', requireAuth, (req, res) => {
  const p = path.join(__dirname, 'public/social-copy.json');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.json({});
});

// ── Social content manifest ───────────────────────────────────
app.get('/api/social-content', requireAuth, (req, res) => {
  const baseDir = path.join(__dirname, 'public/assets/social-content');
  if (!fs.existsSync(baseDir)) return res.json([]);
  const posts = fs.readdirSync(baseDir)
    .filter(f => !f.startsWith('.') && fs.statSync(path.join(baseDir, f)).isDirectory())
    .sort()
    .map(name => ({
      name,
      files: fs.readdirSync(path.join(baseDir, name))
        .filter(f => !f.startsWith('.') && !f.toLowerCase().endsWith('.psd'))
        .map(f => {
          return { name: f, created: getAssetDate('social/' + name + '/' + f) };
        })
    }));
  res.json(posts);
});

// ── Graphics folder (nested paths) ───────────────────────────
app.get('/view-graphic/*', requireAuth, (req, res) => {
  const parts = req.params[0].split('/').map(p => decodeURIComponent(p).replace(/\.\./g, ''));
  const filePath = path.join(__dirname, 'public/assets/graphics', ...parts);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});
app.get('/download-graphic/*', requireAuth, (req, res) => {
  const parts = req.params[0].split('/').map(p => decodeURIComponent(p).replace(/\.\./g, ''));
  const filePath = path.join(__dirname, 'public/assets/graphics', ...parts);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.download(filePath, path.basename(filePath));
});

// ── Gated asset viewer — wildcard (inline) ────────────────────
app.get('/view-asset/*', requireAuth, (req, res) => {
  const parts = req.params[0].split('/').map(p => decodeURIComponent(p).replace(/\.\./g, ''));
  const filePath = path.join(__dirname, 'public/assets', ...parts);
  if (!fs.existsSync(filePath)) return res.status(404).send('Asset not found.');
  res.sendFile(filePath);
});

// ── Gated asset download — wildcard ───────────────────────────
app.get('/download-asset/*', requireAuth, (req, res) => {
  const parts = req.params[0].split('/').map(p => decodeURIComponent(p).replace(/\.\./g, ''));
  const filePath = path.join(__dirname, 'public/assets', ...parts);
  if (!fs.existsSync(filePath)) return res.status(404).send('Asset not found. Please check back later or contact the brand team.');
  res.download(filePath, path.basename(filePath));
});

// ── Legacy routes (logos, templates, social, stationery) ──────
app.get('/view/:category/:filename', requireAuth, (req, res) => {
  const safeCat  = req.params.category.replace(/[^a-z0-9_-]/gi, '');
  const safeFile = path.basename(req.params.filename);
  const filePath = path.join(__dirname, 'public/assets', safeCat, safeFile);
  if (!fs.existsSync(filePath)) return res.status(404).send('Asset not found.');
  res.sendFile(filePath);
});

app.get('/download/:category/:filename', requireAuth, (req, res) => {
  const safeCat  = req.params.category.replace(/[^a-z0-9_-]/gi, '');
  const safeFile = path.basename(req.params.filename);
  const filePath = path.join(__dirname, 'public/assets', safeCat, safeFile);
  if (!fs.existsSync(filePath)) return res.status(404).send('Asset not found. Please check back later or contact the brand team.');
  res.download(filePath, safeFile);
});

// ── Asset manifest API (so the frontend can show what's available) ──
app.get('/api/assets', requireAuth, (req, res) => {
  const baseDir = path.join(__dirname, 'public/assets');
  const manifest = {};

  const categories = ['logos', 'templates', 'social', 'guidelines', 'stationery', 'marketing'];
  for (const cat of categories) {
    const catPath = path.join(baseDir, cat);
    if (fs.existsSync(catPath)) {
      manifest[cat] = fs.readdirSync(catPath)
        .filter(f => !f.startsWith('.') && fs.statSync(path.join(catPath, f)).isFile())
        .map(f => ({ name: f, created: getAssetDate(cat + '/' + f) }));
    } else {
      manifest[cat] = [];
    }
  }

  // Brochures are now in subfolders
  const brochureSubfolders = ['protection', 'leadgen', 'general'];
  manifest.brochures = {};
  for (const sub of brochureSubfolders) {
    const subPath = path.join(baseDir, 'brochures', sub);
    if (fs.existsSync(subPath)) {
      manifest.brochures[sub] = fs.readdirSync(subPath)
        .filter(f => !f.startsWith('.') && fs.statSync(path.join(subPath, f)).isFile())
        .map(f => ({ name: f, created: getAssetDate('brochures/' + sub + '/' + f) }));
    } else {
      manifest.brochures[sub] = [];
    }
  }

  res.json(manifest);
});

// ── Personalised brochure ─────────────────────────────────────
app.post('/personalise-brochure', requireAuth, async (req, res) => {
  try {
    const customerName   = (req.body.customer    || '').trim().slice(0, 80);
    const brokerName     = (req.body.broker      || '').trim().slice(0, 80);
    const brokerImageB64 = req.body.brokerImage  || null;

    const pdfPath  = path.join(__dirname, 'public/assets/brochures/protection/fpg-protection-brochure-2026.pdf');
    const pdfBytes = fs.readFileSync(pdfPath);

    const fontBytes = fs.readFileSync(path.join(__dirname, 'node_modules/dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf'));
    const pdfDoc = await PDFDocument.load(pdfBytes);
    pdfDoc.registerFontkit(fontkit);
    const font = await pdfDoc.embedFont(fontBytes);

    const page = pdfDoc.getPages()[0];
    const { height } = page.getSize();

    const fontSize   = 12;
    const x          = 71;
    const lineHeight = 17;
    // Place just below the subtitle — adjust yStart if needed
    const yStart = height - 627; // up 1cm (~28pts)

    const darkBlue = rgb(2/255, 19/255, 70/255); // Hero Dark Blue CMYK 98.54/84.53/43.58/51.15

    if (customerName) {
      page.drawText('Prepared for: ' + customerName, { x, y: yStart, size: fontSize, font, color: darkBlue });
    }
    if (brokerName) {
      page.drawText('By: ' + brokerName, { x, y: yStart - lineHeight, size: fontSize, font, color: darkBlue });
    }

    // Add first name before "What if..." on inner pages
    const firstName = customerName ? customerName.split(' ')[0] : '';
    if (firstName) {
      const bgColour = rgb(245/255, 247/255, 251/255); // #f5f7fb exact page background
      const whatIfSize = 22;
      const orange = rgb(252/255, 176/255, 52/255); // FPG orange #fcb034
      const pages = pdfDoc.getPages();

      // "What if..." pages — 5, 7, 9, 11 (0-indexed: 4, 6, 8, 10)
      const whatIfPages = [4, 6, 8, 10];
      for (let i = 0; i < pages.length; i++) {
        if (!whatIfPages.includes(i)) continue;
        const p = pages[i];
        const { height: ph } = p.getSize();
        const wy = ph - 71;
        const wx = 55;
        p.drawRectangle({ x: wx - 2, y: wy - 6, width: 300, height: whatIfSize + 14, color: bgColour });
        p.drawText(firstName + ', what if...', { x: wx, y: wy, size: whatIfSize, font, color: darkBlue });
      }

      // "It's a fact..." — page 2 (0-indexed: 1)
      const factp = pages[1];
      if (factp) {
        const { height: fph } = factp.getSize();
        const factSize = 36;
        const mmToPt = 2.835;
        const fx = Math.round(22.5 * mmToPt);                                          // 22.5mm from left = 64pt
        const fy = fph - Math.round(143.737 * mmToPt) - Math.round(factSize * 0.72);  // 143.737mm from top to cap height
        factp.drawRectangle({ x: fx - 2, y: fy - 6, width: 420, height: factSize + 14, color: bgColour });
        factp.drawText(`${firstName}, it’s a fact...`, { x: fx, y: fy, size: factSize, font, color: orange });
      }
    }

    // ── Broker photo (circular, on cover) ──────────────────────
    if (brokerImageB64) {
      try {
        const base64Data = brokerImageB64.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(base64Data, 'base64');
        const isPng  = brokerImageB64.startsWith('data:image/png');
        const brokerImg = isPng ? await pdfDoc.embedPng(imgBuf) : await pdfDoc.embedJpg(imgBuf);

        const r  = 36;           // radius in points (~12.7mm)
        const cx = 71 + r;       // left-aligned with text (x=71)
        const cy = yStart - 17 - 20 - r; // below "By: [broker]" line
        const K  = r * 0.5523;  // Bézier constant for circle

        // Save state, set circular clip, draw image, restore
        page.pushOperators(pushGraphicsState());
        page.pushOperators(
          moveTo(cx, cy + r),
          appendBezierCurve(cx + K, cy + r, cx + r, cy + K, cx + r, cy),
          appendBezierCurve(cx + r, cy - K, cx + K, cy - r, cx, cy - r),
          appendBezierCurve(cx - K, cy - r, cx - r, cy - K, cx - r, cy),
          appendBezierCurve(cx - r, cy + K, cx - K, cy + r, cx, cy + r),
          closePath(),
          clip(),
          endPath()
        );
        page.drawImage(brokerImg, { x: cx - r, y: cy - r, width: r * 2, height: r * 2 });
        page.pushOperators(popGraphicsState());
      } catch (imgErr) {
        console.warn('Broker image embed failed:', imgErr.message);
      }
    }

    const modifiedBytes = await pdfDoc.save();
    const filename = 'FPG-Protection-Brochure' + (customerName ? '-' + customerName.replace(/[^a-z0-9]/gi, '-') : '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(Buffer.from(modifiedBytes));
  } catch (err) {
    console.error('Personalise brochure error:', err);
    res.status(500).send('Could not personalise brochure: ' + err.message);
  }
});

// ── Business card generator ───────────────────────────────────
app.post('/generate-business-card', requireAuth, async (req, res) => {
  try {
    const salutation = (req.body.salutation || 'Mr').trim();
    const firstName  = (req.body.firstName  || '').trim().slice(0, 40);
    const lastName   = (req.body.lastName   || '').trim().slice(0, 40);
    const fullName   = `${firstName} ${lastName}`.trim();
    const title      = (req.body.title || '').trim().slice(0, 80).toUpperCase();
    const email      = (req.body.email || '').trim().slice(0, 80);
    const phone      = (req.body.phone || '').trim().slice(0, 30);
    const url        = (req.body.url   || '').trim().slice(0, 200);

    const templatePath = path.join(__dirname, 'public/assets/stationery/fpg-business-card-template.pdf');
    const pdfBytes = fs.readFileSync(templatePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    pdfDoc.registerFontkit(fontkit);

    const fontBoldBytes = fs.readFileSync(path.join(__dirname, 'public/static/fonts/PlusJakartaSans-ExtraBold.ttf'));
    const fontMedBytes  = fs.readFileSync(path.join(__dirname, 'public/static/fonts/PlusJakartaSans-Medium.ttf'));
    const fontBold = await pdfDoc.embedFont(fontBoldBytes);
    const fontMed  = await pdfDoc.embedFont(fontMedBytes);

    // ── Front page ────────────────────────────────────────────
    const page = pdfDoc.getPages()[0];
    const darkBlue   = rgb(0/255, 55/255, 104/255);
    const accentBlue = rgb(46/255, 153/255, 213/255);
    const darkGrey   = rgb(26/255, 42/255, 58/255);

    page.drawRectangle({ x: 12, y: 10, width: 220, height: 62, color: rgb(1,1,1) });
    page.drawText(fullName, { x: 15.874, y: 57.139, size: 15, font: fontBold, color: darkBlue });
    page.drawText(title,    { x: 15.919, y: 45.650, size: 9,  font: fontMed,  color: accentBlue });
    page.drawText(email,    { x: 15.874, y: 29.634, size: 9,  font: fontMed,  color: darkGrey });
    page.drawText(phone,    { x: 15.874, y: 16.737, size: 9,  font: fontMed,  color: darkGrey });

    // ── Back page — vCard QR ──────────────────────────────────
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `N:${lastName};${firstName};;;${salutation}`,
      `FN:${salutation} ${fullName}`,
      `ORG:Finance Planning Group`,
      `TITLE:${title}`,
      `TEL;TYPE=CELL:${phone}`,
      `TEL;TYPE=WORK:01444 449400`,
      email ? `EMAIL:${email}` : '',
      'ADR;TYPE=WORK:;;Hurstwood Grange;West Sussex;;RH17 8QX;UK',
      'URL:https://financeplanning.co.uk/',
      url ? `URL:${url}` : '',
      'END:VCARD'
    ].filter(Boolean).join('\r\n');

    const qrPngBuffer = await QRCode.toBuffer(vcard, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 300,
      color: { dark: '#003768', light: '#ffffff' }
    });

    const qrImage = await pdfDoc.embedPng(qrPngBuffer);
    const back = pdfDoc.getPages()[1];
    const { width: bw, height: bh } = back.getSize();
    const qrSize = 80;
    back.drawRectangle({ x: (bw - qrSize) / 2, y: (bh - qrSize) / 2, width: qrSize, height: qrSize, color: rgb(232/255, 244/255, 251/255) });
    back.drawImage(qrImage, {
      x: (bw - qrSize) / 2,
      y: (bh - qrSize) / 2,
      width: qrSize,
      height: qrSize
    });

    const modifiedBytes = await pdfDoc.save();
    const safeName = (fullName || 'business-card').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="FPG-Business-Card-${safeName}.pdf"`);
    res.send(Buffer.from(modifiedBytes));
  } catch (err) {
    console.error('Business card error:', err);
    res.status(500).send('Could not generate business card: ' + err.message);
  }
});

// ── Moving card personaliser ──────────────────────────────────
app.post('/generate-moving-card', requireAuth, async (req, res) => {
  try {
    const salutation = (req.body.salutation || 'Mr').trim();
    const firstName  = (req.body.firstName  || '').trim().slice(0, 40);
    const lastName   = (req.body.lastName   || '').trim().slice(0, 40);
    const fullName   = `${firstName} ${lastName}`.trim();
    const title      = (req.body.title || '').trim().slice(0, 80).toUpperCase();
    const email      = (req.body.email || '').trim().slice(0, 80);
    const phone      = (req.body.phone || '').trim().slice(0, 30);
    const landline   = (req.body.landline || '').trim().slice(0, 30);
    const url        = (req.body.url || '').trim().slice(0, 120);

    const templatePath = path.join(__dirname, 'public/assets/marketing/FPG-Moving-Card.pdf');
    const pdfBytes = fs.readFileSync(templatePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    pdfDoc.registerFontkit(fontkit);

    const fontBoldBytes = fs.readFileSync(path.join(__dirname, 'public/static/fonts/PlusJakartaSans-ExtraBold.ttf'));
    const fontMedBytes  = fs.readFileSync(path.join(__dirname, 'public/static/fonts/PlusJakartaSans-Medium.ttf'));
    const fontBold = await pdfDoc.embedFont(fontBoldBytes);
    const fontMed  = await pdfDoc.embedFont(fontMedBytes);

    const page = pdfDoc.getPages()[1];
    const darkBlue   = rgb(0/255, 55/255, 104/255);
    const accentBlue = rgb(46/255, 153/255, 213/255);
    const darkGrey   = rgb(26/255, 42/255, 58/255);

    // White out original business card text block (name through second phone line)
    page.drawRectangle({ x: 48, y: 48, width: 230, height: 70, color: rgb(1,1,1) });

    // Draw personalised text at extracted Tm positions
    page.drawText(fullName, { x: 56.85, y: 104.16, size: 12, font: fontBold, color: darkBlue });
    page.drawText(title,    { x: 56.85, y: 91.96,  size: 8,  font: fontMed,  color: accentBlue });
    page.drawText(email,    { x: 56.85, y: 81.24,  size: 8,  font: fontMed,  color: darkGrey });
    page.drawText(phone,    { x: 56.85, y: 69.05,  size: 8,  font: fontMed,  color: darkGrey });
    if (landline) {
      page.drawText(landline, { x: 56.85, y: 57.71, size: 8, font: fontMed, color: darkGrey });
    }

    // Cover the existing QR placeholder area to the right of the business card on page 1
    page.drawRectangle({ x: 285, y: 40, width: 160, height: 130, color: rgb(1,1,1) });

    // Generate vCard QR
    const vcard = [
      'BEGIN:VCARD', 'VERSION:3.0',
      `N:${lastName};${firstName};;;${salutation}`,
      `FN:${salutation} ${fullName}`,
      'ORG:Finance Planning Group',
      `TITLE:${title}`,
      `TEL;TYPE=CELL:${phone}`,
      landline ? `TEL;TYPE=WORK:${landline}` : 'TEL;TYPE=WORK:01444 449400',
      email ? `EMAIL:${email}` : '',
      'ADR;TYPE=WORK:;;Hurstwood Grange;West Sussex;;RH17 8QX;UK',
      url ? `URL:${url}` : 'URL:https://financeplanning.co.uk/',
      'END:VCARD'
    ].filter(Boolean).join('\r\n');

    const qrPngBuffer = await QRCode.toBuffer(vcard, {
      errorCorrectionLevel: 'M', margin: 1, width: 300,
      color: { dark: '#003768', light: '#ffffff' }
    });
    const qrImage = await pdfDoc.embedPng(qrPngBuffer);

    // Place QR on page 0 (index 0) — under "Scan for more great mortgage and protection advice."
    const scanPage = pdfDoc.getPages()[0];
    const qrSize = 130;
    const qrX = (420 - qrSize) / 2;   // centred in left half (~420pt wide)
    const qrY = 159;
    scanPage.drawRectangle({ x: 55, y: 130, width: 210, height: 162, color: rgb(1,1,1) });
    scanPage.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });

    // Cover original scan text and redraw at smaller size
    // Original: 18pt ExtraBold, two lines centred at x≈210, y centre ≈319.83 (PDF coords)
    scanPage.drawRectangle({ x: 38, y: 295, width: 345, height: 52, color: rgb(1,1,1) });
    const scanFontSize = 13;
    const scanLine1 = 'Scan for more great mortgage';
    const scanLine2 = 'and protection advice.';
    const scanDarkBlue = rgb(0/255, 55/255, 104/255);
    const cx = 210;
    const lineH = scanFontSize * 1.25;
    const scanCentreY = 319.83;
    const s1y = scanCentreY + lineH * 0.5;
    const s2y = scanCentreY - lineH * 0.5;
    const w1 = fontBold.widthOfTextAtSize(scanLine1, scanFontSize);
    const w2 = fontBold.widthOfTextAtSize(scanLine2, scanFontSize);
    scanPage.drawText(scanLine1, { x: cx - w1 / 2, y: s1y, size: scanFontSize, font: fontBold, color: scanDarkBlue });
    scanPage.drawText(scanLine2, { x: cx - w2 / 2, y: s2y, size: scanFontSize, font: fontBold, color: scanDarkBlue });

    // ── Broker logo above scan text ───────────────────────────────
    // broker-branded.png is 2262×1029px; "Broker Name" sits at px x=615–1655, y=228–380 (from top)
    const brokerLogoBytes = fs.readFileSync(path.join(__dirname, 'public/assets/logos/individual broker branding/broker-branded.png'));
    const brokerLogoImg   = await pdfDoc.embedPng(brokerLogoBytes);
    const logoW  = 158;
    const logoH  = Math.round(logoW * 1029 / 2262);   // ≈ 72
    const logoX  = Math.round((419 - logoW) / 2);     // centred in left panel ≈ 131
    const logoY  = 399;                                // equalised gap above scan text (~18pt)
    const sc     = logoW / 2262;

    scanPage.drawImage(brokerLogoImg, { x: logoX, y: logoY, width: logoW, height: logoH });

    // White out "Broker Name" region (image coords → PDF coords, y-axis flipped)
    const wnX = logoX + Math.round(610 * sc);
    const wnY = logoY + Math.round((1029 - 382) * sc);
    const wnW = Math.round(1052 * sc);
    const wnH = Math.round(156 * sc) + 1;
    scanPage.drawRectangle({ x: wnX, y: wnY, width: wnW, height: wnH, color: rgb(1, 1, 1) });

    // Draw personalised name — auto-scale if the name is long
    let nameFontSize = 20;
    const maxNameW = Math.round(981 * sc);
    const measuredW = fontBold.widthOfTextAtSize(fullName, nameFontSize);
    if (measuredW > maxNameW) nameFontSize = Math.floor(nameFontSize * maxNameW / measuredW);
    scanPage.drawText(fullName, {
      x: logoX + Math.round(627 * sc),
      y: wnY + 4,
      size: nameFontSize,
      font: fontBold,
      color: darkBlue
    });

    const modifiedBytes = await pdfDoc.save();
    const safeName = fullName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="FPG-Moving-Card-${safeName}.pdf"`);
    res.send(Buffer.from(modifiedBytes));
  } catch (err) {
    console.error('Moving card error:', err);
    res.status(500).send('Could not generate moving card: ' + err.message);
  }
});


// GET /api/download-broker-logo — personalised broker logo PNG (transparent) for current user
app.get('/api/download-broker-logo', requireAuth, (req, res) => {
  try {
    const user      = req.session.user;
    const firstName = (user.firstName || '').trim();
    const lastName  = (user.lastName  || '').trim();
    const fullName  = [firstName, lastName].filter(Boolean).join(' ') || user.email;
    const safeName  = fullName.replace(/[^a-z0-9]/gi, '-').toLowerCase();

    const imgPath  = path.join(__dirname, 'public/assets/logos/individual broker branding/broker-branded.png');
    const fontPath = path.join(__dirname, 'public/static/fonts/PlusJakartaSans-ExtraBold.ttf');

    const script = `
import sys, json
from PIL import Image, ImageDraw, ImageFont

name      = sys.argv[1]
img_path  = sys.argv[2]
font_path = sys.argv[3]

img  = Image.open(img_path).convert('RGBA')
draw = ImageDraw.Draw(img)

# White-fill the "Broker Name" zone with padding for antialiasing
draw.rectangle([610, 220, 1662, 385], fill=(255, 255, 255, 255))

# Draw name — start at size 156 (matches original design), shrink if name is long
max_w     = 1040
font_size = 156
while font_size >= 60:
    f    = ImageFont.truetype(font_path, font_size)
    bbox = draw.textbbox((0, 0), name, font=f)
    if (bbox[2] - bbox[0]) <= max_w:
        break
    font_size -= 4

# Centre vertically at y=307 (original template text centre)
text_y = round(307 - (bbox[1] + bbox[3]) / 2)
draw.text((627, text_y), name, fill=(0, 55, 104, 255), font=f)

import io
buf = io.BytesIO()
img.save(buf, 'PNG')
sys.stdout.buffer.write(buf.getvalue())
`;

    const { spawnSync } = require('child_process');
    const result = spawnSync('python3', ['-c', script, fullName, imgPath, fontPath], {
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024
    });

    if (result.status !== 0) {
      const err = result.stderr ? result.stderr.toString() : 'unknown error';
      console.error('Broker logo python error:', err);
      return res.status(500).send('Could not generate broker logo');
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="FPG-Broker-Logo-${safeName}.png"`);
    res.send(result.stdout);
  } catch (err) {
    console.error('Broker logo error:', err);
    res.status(500).send('Could not generate broker logo: ' + err.message);
  }
});


// ── Home page data ────────────────────────────────────────────
const FEEFO_TABLE     = 'tblU58wJ0rNFPMiKp';
const FF_ADVISER      = 'Adviser';
const FF_REVIEW       = 'Review';
const FF_SVC_RATING   = 'Service Rating';
const FF_CUSTOMER     = 'Customer Name';

function monthSortKey(filename) {
  const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const m = filename.match(/^([a-z]+)-(\d{4})\.pdf$/i);
  if (!m) return '0';
  return `${m[2]}-${String(months[m[1].toLowerCase()] || 0).padStart(2,'0')}`;
}

app.get('/api/home-data', requireAuth, async (req, res) => {
  try {
    const user     = req.session.user;
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');

    // ── Feefo stats ──────────────────────────────────────────
    let feefo = { avg: null, count: 0, reviews: [] };
    if (fullName) {
      // Case-insensitive, whitespace-tolerant match on Adviser field
      const safeName = fullName.toLowerCase().trim().replace(/"/g, '\\"');
      const formula  = encodeURIComponent(`LOWER(TRIM({${FF_ADVISER}})) = "${safeName}"`);
      let allRecords = [];
      let offset = '';
      do {
        const qs = `?filterByFormula=${formula}&pageSize=100${offset ? '&offset=' + offset : ''}`;
        const url = `https://api.airtable.com/v0/${AT_BASE}/${FEEFO_TABLE}${qs}`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${AT_KEY}` } });
        const body = await r.json();
        if (!r.ok) { console.error('Feefo Airtable error:', body); break; }
        allRecords = allRecords.concat(body.records || []);
        offset = body.offset || '';
      } while (offset);

      const rated = allRecords.filter(r => r.fields[FF_SVC_RATING]);
      feefo.count = allRecords.length;
      if (rated.length) {
        feefo.avg = (rated.reduce((s, r) => s + r.fields[FF_SVC_RATING], 0) / rated.length).toFixed(1);
      }
      // All reviews with text (sorted best-rated first)
      feefo.reviews = allRecords
        .filter(r => r.fields[FF_REVIEW])
        .sort((a, b) => (b.fields[FF_SVC_RATING] || 0) - (a.fields[FF_SVC_RATING] || 0))
        .map(r => ({
          customer: r.fields[FF_CUSTOMER] || 'Customer',
          review:   r.fields[FF_REVIEW],
          rating:   r.fields[FF_SVC_RATING] || null
        }));
    }

    // ── Latest video ─────────────────────────────────────────
    let latestVideo = null;
    try {
      const vData = await lvFetch(`?sort[0][field]=${LV_ADDED}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=1`);
      if (vData.records && vData.records.length) {
        latestVideo = lvRecordToVideo(vData.records[0]);
      }
    } catch(_) {}

    // ── Latest newsletter ─────────────────────────────────────
    let latestNewsletter = null;
    try {
      const nlDir = path.join(__dirname, 'public/newsletters');
      const files = fs.readdirSync(nlDir)
        .filter(f => f.endsWith('.pdf') && f !== 'cover.jpg')
        .sort((a, b) => monthSortKey(b).localeCompare(monthSortKey(a)));
      if (files.length) latestNewsletter = files[0];
    } catch(_) {}

    res.json({ feefo, latestVideo, latestNewsletter });
  } catch (err) {
    console.error('home-data error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Consumer Duty ─────────────────────────────────────────────
const CD_BASE    = 'appJEb2mGCdrEKbpY';
const CD_TABLE   = 'tbl7G4xOwDvtuqUC1';
const CD_BROKER  = 'fldGogTq21yQv6cvo';   // Broker Name
const CD_NAME    = 'flde6kwikjYEnob0j';   // Consumer Name
const CD_DATE    = 'fldilcNWKz6PHuNmX';   // Submitted At
const CD_Q1      = 'fld3auyj1YzfuMZgN';   // Q1 Adviser Knowledge
const CD_Q2      = 'fldgWcvsg4WjrWKIf';   // Q2 Report Accuracy
const CD_Q3      = 'fldK4CFDTNapm37Wv';   // Q3 Report Walkthrough
const CD_Q4      = 'fldt8ZfFPggBqoimR';   // Q4 Rate Type
const CD_Q5      = 'fldrwFb1egdu0z0go';   // Q5 Future Review
const CD_Q6      = 'fldGa0Rh5RfUotGUV';   // Q6 Home At Risk Warning
const CD_Q7      = 'fldCEWMMswuYxQmCf';   // Q7 Protection Importance
const CD_Q8      = 'fldwr5p7c802gejHi';   // Q8 Protection Status
const CD_Q9      = 'fldGxipBKk94ffhax';   // Q9 Literature Clarity
const CD_Q10     = 'fldAENiQSS9W5Dt8V';   // Q10 Support Required
const CD_NPS     = 'fldvT8olEjrbOAG52';   // NPS Rating
const CD_COMMENT = 'fldfsuOr3P3COsXUp';   // Comment

function cdIsPerfect(f) {
  // Returns array of question labels that are unclear/need attention
  const issues = [];
  const a = k => (f[k] || '').trim();
  if (!a(CD_Q1).toLowerCase().startsWith('yes'))                                    issues.push('Q1 Adviser Knowledge');
  if (a(CD_Q4).toLowerCase() === 'unsure')                                          issues.push('Q4 Rate Type');
  if (a(CD_Q5).toLowerCase() === 'no')                                              issues.push('Q5 Future Review');
  if (a(CD_Q6).toLowerCase() === 'no')                                              issues.push('Q6 Home At Risk Warning');
  if (a(CD_Q7).toLowerCase() === 'no')                                              issues.push('Q7 Protection Importance');
  if (a(CD_Q9).toLowerCase() === 'unclear')                                         issues.push('Q9 Literature Clarity');
  if (a(CD_Q10).toLowerCase().includes('did not receive adequate'))                 issues.push('Q10 Support Required');
  if (a(CD_Q3).toLowerCase().includes("i'd like") || a(CD_Q3).toLowerCase().includes('call me')) issues.push('Q3 Walkthrough Requested');
  if (a(CD_Q8).toLowerCase().includes('would like to discuss'))                     issues.push('Q8 Protection Discussion');
  return issues;
}

app.get('/api/consumer-duty', requireAuth, async (req, res) => {
  try {
    const user     = req.session.user;
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
    const safeName = fullName.toLowerCase().trim().replace(/"/g, '\\"');
    const formula  = encodeURIComponent(`LOWER(TRIM({${CD_BROKER}})) = "${safeName}"`);

    let allRecords = [], offset = '';
    do {
      const qs  = `?filterByFormula=${formula}&sort[0][field]=${CD_DATE}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=100${offset ? '&offset=' + offset : ''}`;
      const url = `https://api.airtable.com/v0/${CD_BASE}/${CD_TABLE}${qs}`;
      const r   = await fetch(url, { headers: { Authorization: `Bearer ${AT_KEY}` } });
      const body = await r.json();
      if (!r.ok) { console.error('CD error:', body); break; }
      allRecords = allRecords.concat(body.records || []);
      offset = body.offset || '';
    } while (offset);

    let fullCount = 0, partialCount = 0;
    const records = allRecords.map(rec => {
      const f      = rec.cellValuesByFieldId || rec.fields || {};
      const issues = cdIsPerfect(f);
      const perfect = issues.length === 0;
      return {
        id:       rec.id,
        consumer: f[CD_NAME]    || 'Unknown',
        date:     f[CD_DATE]    || rec.createdTime,
        nps:      f[CD_NPS]     || null,
        comment:  f[CD_COMMENT] || '',
        perfect,
        issues,
        answers: {
          q1:  f[CD_Q1]  || '',
          q2:  f[CD_Q2]  || '',
          q3:  f[CD_Q3]  || '',
          q4:  f[CD_Q4]  || '',
          q5:  f[CD_Q5]  || '',
          q6:  f[CD_Q6]  || '',
          q7:  f[CD_Q7]  || '',
          q8:  f[CD_Q8]  || '',
          q9:  f[CD_Q9]  || '',
          q10: f[CD_Q10] || ''
        }
      };
    });

    res.json({ total: allRecords.length, records });
  } catch (err) {
    console.error('consumer-duty error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── ACRE Surveying Stats ───────────────────────────────────────
const ACRE_BASE        = 'appTQIvpD5TBphlq4';
const ACRE_LEADS_TBL   = 'tblhGuMyeR3zPBJXe';
const ACRE_LEADS_DATE  = 'fldrzUfjSTvxd1cLT';   // Date (dateTime)
const ACRE_SALES_TBL   = 'tbl52e6VsmaJny9f3';
const ACRE_SALES_DATE  = 'fldHbxQKe9DMItj7a';   // Date (date)
const ACRE_SALES_TOT   = 'fld9KJ7Wz9dVl9kqi';   // Total (formula)
const ACRE_BROKER_FEE  = 'fldideRhwhLvMyrlX';   // Broker fee (currency)

async function acreFetchAll(table, formula, fields) {
  let records = [], offset = '';
  const fieldQs = fields.map(f => `fields[]=${f}`).join('&');
  do {
    const qs = `?filterByFormula=${formula}&${fieldQs}&returnFieldsByFieldId=true&pageSize=100${offset ? '&offset=' + offset : ''}`;
    const r  = await fetch(`https://api.airtable.com/v0/${ACRE_BASE}/${table}${qs}`, {
      headers: { Authorization: `Bearer ${AT_KEY}` }
    });
    const body = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(body));
    records = records.concat(body.records || []);
    offset = body.offset || '';
  } while (offset);
  return records;
}

const ACRE_LEADS_INTRO = 'fldfTJD2U9thQ04L7';   // Introducer (singleLineText)
const ACRE_SALES_NAME  = 'fldnFGO1dwvDhbAXP';   // Referred by name (singleLineText)
const ACRE_SALES_EMAIL = 'fldqOLa7fxtmdBwB7';   // Broker Email (email)

app.get('/api/acre-stats', requireAuth, async (req, res) => {
  try {
    const now      = new Date();
    const year     = now.getFullYear();
    const month    = now.getMonth() + 1;
    const user     = req.session.user;
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
    const safeName = fullName.toLowerCase().trim().replace(/"/g, '\\"');
    const email    = (user.email || '').toLowerCase().trim();

    // Leads: filter by Introducer containing the user's name
    const nameFind   = `FIND(LOWER("${safeName}"),LOWER(TRIM({Introducer})))>0`;
    const fLeadMonth = encodeURIComponent(`AND(YEAR({Date})=${year},MONTH({Date})=${month},${nameFind})`);
    const fLeadYear  = encodeURIComponent(`AND(YEAR({Date})=${year},${nameFind})`);

    // Sales: match by broker email OR referred-by-name
    const saleMatch = email
      ? `OR(LOWER(TRIM({Broker Email}))="${email}",FIND(LOWER("${safeName}"),LOWER(TRIM({Referred by name})))>0)`
      : `FIND(LOWER("${safeName}"),LOWER(TRIM({Referred by name})))>0`;
    const fSaleYear = encodeURIComponent(`AND(YEAR({Date})=${year},${saleMatch})`);

    // All sales this year + all users — fetch in parallel
    const fAllSales  = encodeURIComponent(`YEAR({Date})=${year}`);
    const usersUrl   = `https://api.airtable.com/v0/appqQv0Xog8yZMwI9/tbltcinwWF3FXDGre?fields[]=flde9n3BkKQsJFoYB&fields[]=flduFe3YHfQB7f7LQ&pageSize=100`;

    // Fetch all user pages
    async function fetchAllUsers() {
      let users = [], offset = '';
      do {
        const r    = await fetch(usersUrl + (offset ? `&offset=${offset}` : ''), { headers: { Authorization: `Bearer ${AT_KEY}` } });
        const body = await r.json();
        users  = users.concat(body.records || []);
        offset = body.offset || '';
      } while (offset);
      return users;
    }

    // All-time sales for this broker (no year filter)
    const fSaleAllTime = encodeURIComponent(saleMatch);

    // All leads this month/year (no broker filter) for rank calculation
    const fAllLeadsMonth = encodeURIComponent(`AND(YEAR({Date})=${year},MONTH({Date})=${month})`);
    const fAllLeadsYear  = encodeURIComponent(`YEAR({Date})=${year}`);

    const [leadsMonth, leadsYear, salesAllTime, allSales, allLeadsMonth, allLeadsYear, allUsers] = await Promise.all([
      acreFetchAll(ACRE_LEADS_TBL, fLeadMonth,      [ACRE_LEADS_DATE]),
      acreFetchAll(ACRE_LEADS_TBL, fLeadYear,       [ACRE_LEADS_DATE]),
      acreFetchAll(ACRE_SALES_TBL, fSaleAllTime,    [ACRE_SALES_DATE, ACRE_BROKER_FEE]),
      acreFetchAll(ACRE_SALES_TBL, fAllSales,       [ACRE_SALES_DATE, ACRE_BROKER_FEE, ACRE_SALES_NAME]),
      acreFetchAll(ACRE_LEADS_TBL, fAllLeadsMonth,  [ACRE_LEADS_INTRO]),
      acreFetchAll(ACRE_LEADS_TBL, fAllLeadsYear,   [ACRE_LEADS_INTRO]),
      fetchAllUsers()
    ]);

    // Build set of known adviser full names (lowercase)
    const adviserNames = new Set(allUsers.map(u => {
      const f = u.fields || {};
      return `${f['First Name'] || ''} ${f['Last Name'] || ''}`.trim().toLowerCase();
    }).filter(Boolean));

    const salesValue = salesAllTime.reduce((sum, rec) => {
      const f = rec.cellValuesByFieldId || rec.fields || {};
      return sum + (parseFloat(f[ACRE_BROKER_FEE] || 0) || 0);
    }, 0);

    // Rank: group all YTD sales by broker name, only include known advisers
    const brokerFees  = {};
    const brokerCount = {};
    adviserNames.forEach(n => { brokerFees[n] = 0; brokerCount[n] = 0; });
    allSales.forEach(rec => {
      const f    = rec.cellValuesByFieldId || rec.fields || {};
      const name = (f[ACRE_SALES_NAME] || '').trim().toLowerCase();
      if (!adviserNames.has(name)) return;
      brokerFees[name]  = (brokerFees[name]  || 0) + (parseFloat(f[ACRE_BROKER_FEE] || 0) || 0);
      brokerCount[name] = (brokerCount[name] || 0) + 1;
    });

    const sortedFees   = Object.values(brokerFees).sort((a, b) => b - a);
    const sortedCounts = Object.values(brokerCount).sort((a, b) => b - a);
    const userFee      = brokerFees[safeName]  || 0;
    const userCount    = brokerCount[safeName] || 0;
    const commRank     = sortedFees.findIndex(v => v <= userFee)     + 1;
    const salesRank    = sortedCounts.findIndex(v => v <= userCount) + 1;

    // Leads rank — group by Introducer (first word match on adviser name)
    function leadsRank(allLeads) {
      const counts = {};
      adviserNames.forEach(n => { counts[n] = 0; });
      allLeads.forEach(rec => {
        const f    = rec.cellValuesByFieldId || rec.fields || {};
        const raw  = (f[ACRE_LEADS_INTRO] || '').trim().toLowerCase();
        // Match adviser name against start of Introducer field
        const match = [...adviserNames].find(n => raw.startsWith(n));
        if (!match) return;
        counts[match] = (counts[match] || 0) + 1;
      });
      const sorted   = Object.values(counts).sort((a, b) => b - a);
      const userVal  = counts[safeName] || 0;
      return sorted.findIndex(v => v <= userVal) + 1;
    }

    const leadsMonthRank = leadsRank(allLeadsMonth);
    const leadsYearRank  = leadsRank(allLeadsYear);

    res.json({
      leadsThisMonth:  leadsMonth.length,
      leadsThisYear:   leadsYear.length,
      salesAllTime:    salesAllTime.length,
      salesValue:      salesValue,
      commRank:        commRank        || null,
      salesRank:       salesRank       || null,
      leadsMonthRank:  leadsMonthRank  || null,
      leadsYearRank:   leadsYearRank   || null,
      totalBrokers:    adviserNames.size
    });
  } catch (err) {
    console.error('acre-stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── News Bulletins ────────────────────────────────────────────
const NEWS_TBL        = 'tbltfeViC5SfCniWt';
const NEWS_TITLE      = 'fldvFmS9h4SIX3KjL'; // Name
const NEWS_BODY       = 'fldflwv29d6J4evSg'; // Notes
const NEWS_STATUS     = 'fldxaOk1OBldIt3sY'; // Status (singleSelect)
const NEWS_ATTACH     = 'fld8CRM6Fv3syLSX2'; // Attachments

app.get('/api/news-bulletins', requireAuth, async (req, res) => {
  try {
    const formula = encodeURIComponent(`{Status}="Published"`);
    const url = `https://api.airtable.com/v0/${AT_BASE}/${NEWS_TBL}?filterByFormula=${formula}&fields[]=Name&fields[]=Notes&fields[]=Attachments&pageSize=20`;
    const r   = await fetch(url, { headers: { Authorization: `Bearer ${AT_KEY}` } });
    const body = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(body));
    const bulletins = (body.records || [])
      .filter(rec => rec.fields && rec.fields['Name'])
      .map(rec => {
        const f = rec.fields || {};
        const attach = (f['Attachments'] || [])[0];
        return {
          id:        rec.id,
          title:     f['Name']  || '',
          body:      f['Notes'] || '',
          imageUrl:  attach ? (attach.thumbnails && attach.thumbnails.large ? attach.thumbnails.large.url : attach.url) : null,
          createdAt: rec.createdTime
        };
      });
    res.json(bulletins);
  } catch (err) {
    console.error('news-bulletins error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/share/advisers — all advisers (supervisors only)
app.get('/api/share/advisers', requireAuth, async (req, res) => {
  if (!req.session.user.isSupervisor && !req.session.user.isAdmin) {
    return res.status(403).json({ error: 'Supervisors only' });
  }
  try {
    const users = [];
    let offset = '';
    do {
      const qs = `?returnFieldsByFieldId=true&pageSize=100${offset ? '&offset=' + offset : ''}`;
      const data = await atFetch(qs);
      for (const r of (data.records || [])) {
        const u = recordToUser(r);
        if (u.email) users.push({ id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email, email: u.email });
      }
      offset = data.offset || '';
    } while (offset);
    users.sort((a, b) => a.name.localeCompare(b.name));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/share/standards — email a section to selected advisers
app.post('/api/share/standards', requireAuth, async (req, res) => {
  if (!req.session.user.isSupervisor && !req.session.user.isAdmin) {
    return res.status(403).json({ error: 'Supervisors only' });
  }
  const { recipients, sectionTitle, docTitle, deepLink, bodyHtml } = req.body;
  if (!recipients || !recipients.length) return res.status(400).json({ error: 'No recipients' });

  const sender = req.session.user;
  const senderName = [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.email;
  const appUrl = process.env.APP_URL || 'https://your-app.railway.app';
  const linkUrl = appUrl + (deepLink || '');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2a3a;">
      <div style="background:#003768;padding:20px 28px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;color:#fff;font-weight:700;">Finance Planning Group</h1>
        <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,.7);">Advice Standards</p>
      </div>
      <div style="padding:24px 28px;background:#fff;border:1px solid #e8ecf0;border-top:none;">
        <p style="margin:0 0 16px;font-size:14px;color:#2c3e50;">
          <strong>${senderName}</strong> has shared a section of the <strong>${docTitle}</strong> with you.
        </p>
        <div style="background:#f5f7fa;border-left:4px solid #003768;padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:20px;">
          <p style="margin:0;font-size:13px;font-weight:700;color:#003768;">${sectionTitle}</p>
        </div>
        <div style="font-size:13px;color:#2c3e50;line-height:1.7;margin-bottom:24px;">
          ${bodyHtml || ''}
        </div>
        <a href="${linkUrl}" style="display:inline-block;background:#003768;color:#fff;text-decoration:none;padding:11px 22px;border-radius:7px;font-size:14px;font-weight:600;">Open in FPG Hub →</a>
      </div>
      <div style="padding:14px 28px;background:#f5f7fa;border:1px solid #e8ecf0;border-top:none;border-radius:0 0 8px 8px;font-size:11px;color:#9baabb;">
        Sent by ${senderName} via FPG Digital Hub
      </div>
    </div>`;

  try {
    const transport = makeMailTransport();
    await Promise.all(recipients.map(email =>
      transport.sendMail({
        from: `"${senderName} via FPG Hub" <${process.env.SMTP_USER}>`,
        to: email,
        subject: `${senderName} shared: ${sectionTitle} – ${docTitle}`,
        html,
      })
    ));
    res.json({ sent: recipients.length });
  } catch (err) {
    console.error('Share email error:', err.message);
    res.status(500).json({ error: 'Email failed: ' + err.message });
  }
});

// GET /api/dip-certificate — generate FPG branded DIP certificate PDF
app.get('/api/dip-certificate', requireAuth, async (req, res) => {
  try {
    const { amount, names } = req.query;
    if (!amount || !names) return res.status(400).json({ error: 'amount and names are required' });

    const user = req.session.user;
    const brokerName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

    // Load assets
    const fontBoldBytes = fs.readFileSync(path.join(__dirname, 'public/static/fonts/PlusJakartaSans-ExtraBold.ttf'));
    const fontMedBytes  = fs.readFileSync(path.join(__dirname, 'public/static/fonts/PlusJakartaSans-Medium.ttf'));
    const logoBytes     = fs.readFileSync(path.join(__dirname, 'public/assets/logos/web/FPG-Logo-Transparent.png'));

    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const fontBold = await pdfDoc.embedFont(fontBoldBytes);
    const fontMed  = await pdfDoc.embedFont(fontMedBytes);
    const logoImg  = await pdfDoc.embedPng(logoBytes);

    const W = 595.276, H = 841.89; // A4 exact
    const page = pdfDoc.addPage([W, H]);

    // ── Colors (matched exactly from template via CMYK extraction) ─
    const navy     = rgb(0,        55/255,  104/255); // #003768 FPG navy
    const gold     = rgb(252/255, 176/255,  52/255);  // #FCB034 FPG gold
    const greyCol  = rgb(107/255, 124/255, 143/255);  // disclaimer text
    const dark     = rgb(26/255,   42/255,  58/255);  // body text
    const white    = rgb(1, 1, 1);
    // Template box row colors converted from CMYK values in PDF
    const rowDark  = rgb(207/255, 240/255, 247/255);  // CMYK(0.19,0.06,0.03,0) — rows 1 & 3
    const rowLight = rgb(232/255, 250/255, 255/255);  // CMYK(0.09,0.02,0.00,0) — row 2

    // ── Layout: exact measurements from template analysis ─────────
    // Template uses x=70.866 for left edge of content/box
    const ML  = 70.866;
    const MR  = 70.866;
    const CW  = W - ML - MR; // 453.543 (matches template box width exactly)
    // Box right edge = 70.866 + 453.543 = 524.409 (matches template)

    // Dates
    const today = new Date();
    const fmtDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const todayStr = fmtDate(today);

    // Format loan amount
    const amtClean     = amount.toString().replace(/[^0-9.]/g, '');
    const amtNum       = parseFloat(amtClean);
    const amtFormatted = isNaN(amtNum) ? amount : '£' + amtNum.toLocaleString('en-GB', { minimumFractionDigits: 0 });

    // ── Text helpers ──────────────────────────────────────────────
    function wrapText(text, font, size, maxWidth) {
      const words = text.split(' ');
      const lines = [];
      let current = '';
      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (font.widthOfTextAtSize(test, size) <= maxWidth) {
          current = test;
        } else {
          if (current) lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
      return lines;
    }
    // Returns y position after last line drawn
    function drawWrapped(text, font, size, color, x, y, maxWidth, leading) {
      for (const line of wrapText(text, font, size, maxWidth)) {
        page.drawText(line, { x, y, size, font, color });
        y -= leading;
      }
      return y;
    }

    // ── 1. White background ───────────────────────────────────────
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: white });

    // ── 2. Navy top bar (exact from template: y=826.299, h=15.591) ─
    page.drawRectangle({ x: 0, y: 826.299, width: W, height: 15.591, color: navy });

    // ── 3. FPG Logo centred ────────────────────────────────────────
    // Template: logo text area tops at ~65.8pt from page top → PDF y = H-65.8 ≈ 776
    //           logo spans ~53pt tall → bottom at PDF y ≈ 723
    const logoH = 53;
    const logoAspect = logoImg.width / logoImg.height;
    const logoW = logoH * logoAspect;
    page.drawImage(logoImg, {
      x: (W - logoW) / 2,
      y: H - 65.8 - logoH,  // top of logo 65.8pt from page top
      width: logoW,
      height: logoH
    });

    // ── 4. Title "Decision In Principle" ──────────────────────────
    // Template: title baseline at ~635 in PDF coords (26pt text, top=183.9 from page top)
    const titleTxt  = 'Decision In Principle';
    const titleSize = 26;
    const titleW2   = fontBold.widthOfTextAtSize(titleTxt, titleSize);
    page.drawText(titleTxt, {
      x: (W - titleW2) / 2,
      y: H - 183.9 - titleSize + 3,  // ≈ 635
      size: titleSize, font: fontBold, color: dark
    });

    // ── 5. Intro paragraph ────────────────────────────────────────
    // Template: intro starts at top=225.3 from page top → PDF y ≈ 608
    const introText = 'We are pleased to confirm that your application has been approved in principle. This is subject to:';
    let y = H - 225.3 - 10 + 2; // ≈ 608
    y = drawWrapped(introText, fontMed, 10, dark, ML, y, CW, 12);

    // ── 6. Subject-to bullets ─────────────────────────────────────
    // Template: bullet 1 at top=249.3 → PDF y ≈ 584
    // Override with our calculated y (after intro) — keeps consistent spacing
    y -= 2;
    const subjectBullets = [
      'A satisfactory valuation of the property to be mortgaged.',
      'The information you have supplied to us being true and accurate.',
      'Our Mortgage Conditions and the terms of any mortgage offer.',
      'A full appraisal of the information contained in a completed application form including an assessment that you are able to repay the mortgage.',
    ];
    for (const b of subjectBullets) {
      page.drawText('•', { x: ML, y, size: 10, font: fontMed, color: dark });
      y = drawWrapped(b, fontMed, 10, dark, ML + 18, y, CW - 18, 12);
    }

    // ── 7. Info box (EXACT positions from template PDF analysis) ──
    // All y values are in pdf-lib coords (from bottom of page)
    // Row heights = 36.85pt each, measured from template rects
    const boxRows = [
      { yBot: 470.551, yTop: 507.401, color: rowDark,  label: 'Maximum loan amount', value: amtFormatted },
      { yBot: 433.701, yTop: 470.551, color: rowLight, label: 'Applicant name(s)',   value: names        },
      { yBot: 396.851, yTop: 433.701, color: rowDark,  label: 'Date issued',         value: todayStr     },
    ];
    const rowH    = 36.85;
    const boxYBot = 396.851;
    const boxYTop = 507.401;

    for (const row of boxRows) {
      // Shaded background
      page.drawRectangle({ x: ML, y: row.yBot, width: CW, height: rowH, color: row.color });

      // Label (bold, left-aligned, vertically centred)
      const labelY = row.yBot + rowH / 2 - 4; // centre of row minus half font cap height
      page.drawText(row.label, { x: ML + 12, y: labelY, size: 10, font: fontBold, color: dark });

      // Value — right portion, same vertical centre
      const valueX   = ML + 230; // label takes ~0-220pt, value from 230pt
      const valueMaxW = CW - 230 - 8;
      const valueLines = wrapText(row.value, fontMed, 10, valueMaxW);
      const valBlockH  = valueLines.length * 12;
      let vY = row.yBot + rowH / 2 + valBlockH / 2 - 10;
      for (const vl of valueLines) {
        page.drawText(vl, { x: valueX, y: vY, size: 10, font: fontMed, color: dark });
        vY -= 12;
      }
    }

    // Thin border around entire box
    page.drawRectangle({
      x: ML, y: boxYBot, width: CW, height: boxYTop - boxYBot,
      borderColor: rgb(180/255, 205/255, 225/255), borderWidth: 0.5, color: undefined
    });
    // Row dividers
    page.drawLine({ start: { x: ML, y: 470.551 }, end: { x: ML + CW, y: 470.551 }, thickness: 0.5, color: rgb(180/255, 205/255, 225/255) });
    page.drawLine({ start: { x: ML, y: 433.701 }, end: { x: ML + CW, y: 433.701 }, thickness: 0.5, color: rgb(180/255, 205/255, 225/255) });

    // ── 8. Please note section ────────────────────────────────────
    // Template: first please-note bullet at top=480.4 → PDF y ≈ 353
    // Header "Please note:" sits ~20pt above first bullet
    page.drawText('Please note:', { x: ML, y: 376, size: 10, font: fontBold, color: dark });
    y = 353; // first bullet baseline (matches template exactly)

    const pleaseNotes = [
      'You should not enter into a binding legal commitment to buy a property until you have received, and are happy with, the full mortgage offer.',
      'You must tell us if any of the information you have given us changes. You must also tell us if something happens, or is likely to happen which might affect our decision to make you a mortgage offer. Your mortgage adviser can provide you with further information.',
      'We will set out full details of the terms on which we will make the loan in the mortgage offer.',
      'This document does not contain all of the details you need to choose a mortgage. Please make sure you obtain an illustration before you make a decision.',
      'We may request references when applicable.',
    ];
    for (const note of pleaseNotes) {
      page.drawText('•', { x: ML, y, size: 10, font: fontMed, color: dark });
      y = drawWrapped(note, fontMed, 10, dark, ML + 18, y, CW - 18, 12);
    }

    // ── 9. Disclaimer (3 lines at bottom, matching template positions) ─
    // Template: line 1 at top=771.3 → PDF y ≈ 65, line 2 at top=785.7 → y ≈ 51, line 3 at top=792.9 → y ≈ 44
    const discParts = [
      { text: 'Finance Planning Mortgage & Protection Solutions is a trading name of The Finance Planning Group Limited, which is authorised and regulated by the Financial Conduct Authority.', y: 65 },
      { text: 'The Finance Planning Group Limited, registered in England and Wales, 3894404.', y: 51 },
      { text: 'Registered office: Hurstwood Grange, Hurstwood Lane, Haywards Heath, West Sussex RH17 7QX', y: 44 },
    ];
    for (const dp of discParts) {
      page.drawText(dp.text, { x: 36, y: dp.y, size: 6.5, font: fontMed, color: greyCol });
    }

    // ── 10. Broker business card (bottom-left, above disclaimer) ──
    const cardW = 195, cardH = 90;
    const cardX = ML;
    const cardY = 75; // sits above disclaimer block

    page.drawRectangle({ x: cardX, y: cardY, width: cardW, height: cardH, color: navy });
    page.drawRectangle({ x: cardX, y: cardY + cardH - 5, width: cardW, height: 5, color: gold });

    let cY = cardY + cardH - 20;
    const cardNameLines = wrapText(brokerName, fontBold, 9.5, cardW - 16);
    for (const l of cardNameLines) {
      page.drawText(l, { x: cardX + 8, y: cY, size: 9.5, font: fontBold, color: white });
      cY -= 12;
    }
    if (user.jobTitle) {
      page.drawText(user.jobTitle, { x: cardX + 8, y: cY, size: 7.5, font: fontMed, color: gold });
      cY -= 11;
    }
    if (user.mobile) {
      page.drawText('M: ' + user.mobile, { x: cardX + 8, y: cY, size: 7.5, font: fontMed, color: white });
      cY -= 10;
    }
    if (user.email) {
      for (const l of wrapText(user.email, fontMed, 7.5, cardW - 16)) {
        page.drawText(l, { x: cardX + 8, y: cY, size: 7.5, font: fontMed, color: white });
        cY -= 10;
      }
    }
    page.drawText('Finance Planning Group', { x: cardX + 8, y: cardY + 7, size: 6.5, font: fontMed, color: rgb(0.55, 0.70, 0.85) });

    // Send PDF
    const pdfBytes = await pdfDoc.save();
    const safeNames = (names || 'Applicant').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-').substring(0, 40);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="FPG-DIP-${safeNames}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('DIP cert error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Feature flags API ─────────────────────────────────────────
app.get('/api/admin/features', (req, res) => {
  res.json(_features);
});

app.post('/api/admin/features', requireAdmin, (req, res) => {
  try {
    const updates = req.body;
    const allowed = Object.keys(FEATURES_DEFAULT);
    allowed.forEach(k => { if (k in updates) _features[k] = !!updates[k]; });
    fs.writeFileSync(FEATURES_PATH, JSON.stringify(_features, null, 2), 'utf8');
    res.json({ ok: true, features: _features });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FPG Digital Asset Management Tool running on port ${PORT}`);
});
