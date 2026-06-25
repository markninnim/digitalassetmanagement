require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, moveTo, appendBezierCurve, closePath, clip, endPath } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const QRCode  = require('qrcode');

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
const F_AVATAR         = 'fldiQ06FtP4BehJU7';

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
    avatarUrl:        f[F_AVATAR]           || ''
  };
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);
app.use(session({
  secret: SECRET,
  resave: true,
  saveUninitialized: true,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 365 * 10, secure: process.env.NODE_ENV === 'production' } // 10 years
}));

// ── Auth guards ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.authenticated && req.session.user && req.session.user.isAdmin) return next();
  res.status(403).json({ error: 'Forbidden' });
}

function requireSupervisor(req, res, next) {
  if (req.session.authenticated && req.session.user && req.session.user.isSupervisor) return next();
  res.status(403).json({ error: 'Forbidden' });
}

// ── Serve static assets (only after auth) ───────────────────
// Public assets are gated — we serve them via a route, not express.static
app.use('/static', express.static(path.join(__dirname, 'public/static')));

// ── Public logo (for display only) ──────────────────────────
app.get('/public-logo', (req, res) => {
  const p = require('path').join(__dirname, 'public/assets/logos/web/FPG-Logo-Transparent.png');
  if (require('fs').existsSync(p)) res.sendFile(p);
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
  try {
    const formula = encodeURIComponent(`{Email}="${email.trim().toLowerCase()}"`);
    const data = await atFetch(`?filterByFormula=${formula}&returnFieldsByFieldId=true`);
    if (!data.records || data.records.length === 0) return res.redirect('/login?error=1');
    const record = data.records[0];
    const hash = record.fields[F_PASSWORD];
    if (!hash || !bcrypt.compareSync(password, hash)) return res.redirect('/login?error=1');
    req.session.authenticated = true;
    req.session.user = recordToUser(record);
    res.redirect('/');
  } catch (err) {
    console.error('Login error:', err);
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── Current user ─────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.session.user || {});
});

// ── Profile: current user self-edit ──────────────────────────
app.put('/api/profile', requireAuth, async (req, res) => {
  const { salutation, firstName, lastName, jobTitle, mobile, landline, website, password } = req.body;
  const id = req.session.user.id;
  try {
    const fields = {
      [F_SAL]:      salutation || '',
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
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const data = await atFetch(`?returnFieldsByFieldId=true&pageSize=100`);
    const users = (data.records || []).map(r => {
      const u = recordToUser(r);
      u.hasPassword = !!r.fields[F_PASSWORD];
      return u;
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: create user ────────────────────────────────────────
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { email, password, salutation, firstName, lastName, jobTitle, mobile, landline, website, isAdmin, sellsMortgages, sellsProtection, sellsInvestments, isSupervisor, supervisorEmail } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const fields = {
      [F_EMAIL]:       email.trim().toLowerCase(),
      [F_PASSWORD]:    hash,
      [F_SAL]:         salutation  || '',
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
    res.json(recordToUser(data.records[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: update user ────────────────────────────────────────
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { password, salutation, firstName, lastName, jobTitle, mobile, landline, website, isAdmin, sellsMortgages, sellsProtection, sellsInvestments, isSupervisor, supervisorEmail } = req.body;
  try {
    const fields = {
      [F_SAL]:              salutation  || '',
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
    res.json(recordToUser(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: delete user ────────────────────────────────────────
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await atFetch(`/${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Supervisor: team CPD dashboard ───────────────────────────
app.get('/api/supervisor/team', requireSupervisor, async (req, res) => {
  const supervisorEmail = req.session.user.email;
  try {
    // 1. Get team members (users whose Supervisor Email = this supervisor)
    const formula = encodeURIComponent(`{Supervisor Email}="${supervisorEmail}"`);
    const teamData = await atFetch(`?filterByFormula=${formula}&returnFieldsByFieldId=true&pageSize=100`);
    const members = (teamData.records || []).map(r => {
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
    const cpdData = await cpdFetch(`?filterByFormula=${cpdFormula}&returnFieldsByFieldId=true&pageSize=1000`);
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
app.get('/api/learning', requireAuth, async (req, res) => {
  try {
    const data = await lvFetch(`?sort[0][field]=${LV_ADDED}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=100`);
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
    const data = await cpdFetch(`?filterByFormula=${formula}&sort[0][field]=${CPD_DATE}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=100`);
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
  const { activity, date, minutes, category, cpdType, learned } = req.body;
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
        [CPD_SOURCE]:   'Manual',
        [CPD_TYPE]:     cpdType || 'Mortgage',
        ...(learned ? { [CPD_LEARNED]: learned } : {})
      }}], returnFieldsByFieldId: true })
    });
    res.json(cpdRecordToEntry(data.records[0]));
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
    const data = await cpdFetch(`?filterByFormula=${formula}&sort[0][field]=${CPD_DATE}&sort[0][direction]=desc&returnFieldsByFieldId=true&pageSize=100`);
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

    // ── Progress card (white) ──────────────────────────────────
    const progressCardTop = y;
    page.drawRectangle({ x: 20, y: y - 148, width: W - 40, height: 158, color: white, borderRadius: 6 });
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

    // ── Entries card (white) ───────────────────────────────────
    const entryRowH = 18;
    const entriesCardH = 36 + entries.length * entryRowH + 20;
    page.drawRectangle({ x: 20, y: y - entriesCardH, width: W - 40, height: entriesCardH + 10, color: white, borderRadius: 6 });
    y -= 10;
    page.drawText('Entries (' + entries.length + ')', { x: 36, y, size: 11, font: fontBold, color: darkBlue });
    y -= 16;

    // Table header row
    const cols = [{ x:36, label:'Date' }, { x:114, label:'Activity' }, { x:310, label:'Type' }, { x:398, label:'Category' }, { x:514, label:'Time' }];
    page.drawRectangle({ x: 20, y: y - 5, width: W - 40, height: 18, color: pageBg });
    cols.forEach(c => page.drawText(c.label, { x: c.x, y: y+1, size: 7.5, font: fontBold, color: midGrey }));
    y -= 20;

    const truncate = (s, max) => s && s.length > max ? s.slice(0, max-1) + '…' : (s || '');
    let currentPage = page;
    entries.forEach((e, i) => {
      // New page if needed
      if (y < 60) {
        const np = pdfDoc.addPage([W, H]);
        np.drawRectangle({ x: 0, y: 0, width: W, height: H, color: pageBg });
        np.drawRectangle({ x: 0, y: H - headerH, width: W, height: headerH, color: white });
        np.drawRectangle({ x: 0, y: H - headerH, width: W, height: 3, color: darkBlue });
        np.drawImage(logoImg, { x: logoX, y: logoY, width: logoDims.width, height: logoDims.height });
        np.drawText(userName + ' — continued', { x: W - 28 - fontBold.widthOfTextAtSize(userName + ' — continued', 13), y: H - 42, size: 13, font: fontBold, color: darkBlue });
        currentPage = np;
        y = H - headerH - 36;
        currentPage.drawRectangle({ x: 20, y: 40, width: W - 40, height: y - 40, color: white, borderRadius: 6 });
        y -= 10;
        currentPage.drawRectangle({ x: 20, y: y - 5, width: W - 40, height: 18, color: pageBg });
        cols.forEach(c => currentPage.drawText(c.label, { x: c.x, y: y+1, size: 7.5, font: fontBold, color: midGrey }));
        y -= 20;
      }
      if (i % 2 !== 0) currentPage.drawRectangle({ x: 20, y: y - 5, width: W - 40, height: 16, color: pageBg });
      const d = e.date ? new Date(e.date).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) : '—';
      currentPage.drawText(d,                                  { x: cols[0].x, y, size: 8, font: fontMed,  color: grey });
      currentPage.drawText(truncate(e.activity, 30),           { x: cols[1].x, y, size: 8, font: fontBold, color: darkBlue });
      currentPage.drawText(truncate(e.cpdType, 12),            { x: cols[2].x, y, size: 8, font: fontMed,  color: e.cpdType === 'Mortgage' ? accentBlue : amber });
      currentPage.drawText(truncate(e.category, 18),           { x: cols[3].x, y, size: 8, font: fontMed,  color: grey });
      currentPage.drawText(fmtMin(e.minutes),                  { x: cols[4].x, y, size: 8, font: fontBold, color: darkBlue });
      if (e.learned) {
        y -= 11;
        currentPage.drawText('  ' + truncate(e.learned, 82),  { x: cols[1].x, y, size: 7, font: fontMed,  color: midGrey });
      }
      y -= 17;
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
          const stat = fs.statSync(path.join(baseDir, name, f));
          return { name: f, created: stat.birthtime || stat.mtime };
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
        .map(f => {
          const stat = fs.statSync(path.join(catPath, f));
          return { name: f, created: stat.birthtime || stat.mtime };
        });
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
        .map(f => {
          const stat = fs.statSync(path.join(subPath, f));
          return { name: f, created: stat.birthtime || stat.mtime };
        });
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

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FPG Digital Asset Management Tool running on port ${PORT}`);
});
