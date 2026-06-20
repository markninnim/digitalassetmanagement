require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.BRAND_HUB_PASSWORD || 'fpg2026';
const SECRET   = process.env.SESSION_SECRET || 'dev-secret-change-me';

// ── Middleware ───────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('trust proxy', 1);
app.use(session({
  secret: SECRET,
  resave: true,
  saveUninitialized: true,
  cookie: { maxAge: 1000 * 60 * 60 * 8, secure: false } // 8 hours
}));

// ── Auth guard ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  return next(); // auth disabled temporarily
}

// ── Serve static assets (only after auth) ───────────────────
// Public assets are gated — we serve them via a route, not express.static
app.use('/static', express.static(path.join(__dirname, 'public/static')));

// ── Public logo (for display only) ──────────────────────────
app.get('/public-logo', (req, res) => {
  const p = require('path').join(__dirname, 'public/assets/logos/fpg-logo-transparent.png');
  if (require('fs').existsSync(p)) res.sendFile(p);
  else res.status(404).send('Not found');
});

// ── Login routes ─────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── Main app ─────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// ── Video content download ────────────────────────────────────
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
  const posts = fs.readdirSync(baseDir)
    .filter(f => !f.startsWith('.') && fs.statSync(path.join(baseDir, f)).isDirectory())
    .sort()
    .map(name => ({
      name,
      files: fs.readdirSync(path.join(baseDir, name))
        .filter(f => !f.startsWith('.') && fs.statSync(path.join(baseDir, name, f)).isFile())
        .map(f => {
          const stat = fs.statSync(path.join(baseDir, name, f));
          return { name: f, created: stat.birthtime || stat.mtime };
        })
    }));
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

// ── Gated asset downloads ─────────────────────────────────────
app.get('/download/:category/:filename', requireAuth, (req, res) => {
  const { category, filename } = req.params;

  // Sanitise — no path traversal
  const safeCat  = category.replace(/[^a-z0-9_-]/gi, '');
  const safeFile = path.basename(filename);
  const filePath = path.join(__dirname, 'public/assets', safeCat, safeFile);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Asset not found. Please check back later or contact the brand team.');
  }

  res.download(filePath, safeFile);
});

// ── Asset manifest API (so the frontend can show what's available) ──
app.get('/api/assets', requireAuth, (req, res) => {
  const baseDir = path.join(__dirname, 'public/assets');
  const manifest = {};

  const categories = ['logos', 'templates', 'social', 'guidelines', 'brochures'];
  for (const cat of categories) {
    const catPath = path.join(baseDir, cat);
    if (fs.existsSync(catPath)) {
      manifest[cat] = fs.readdirSync(catPath).filter(f => !f.startsWith('.'));
    } else {
      manifest[cat] = [];
    }
  }

  res.json(manifest);
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FPG Brand Hub running on port ${PORT}`);
});
