require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const fs       = require('fs');
const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, moveTo, appendBezierCurve, closePath, clip, endPath } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const app  = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.BRAND_HUB_PASSWORD || 'fpg2026';
const SECRET   = process.env.SESSION_SECRET || 'dev-secret-change-me';

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

// ── Auth guard ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
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

  const categories = ['logos', 'templates', 'social', 'guidelines', 'stationery'];
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
    const name     = (req.body.name     || '').trim().slice(0, 60);
    const title    = (req.body.title    || '').trim().slice(0, 80).toUpperCase();
    const email    = (req.body.email    || '').trim().slice(0, 80);
    const phone    = (req.body.phone    || '').trim().slice(0, 30);

    const templatePath = path.join(__dirname, 'public/assets/stationery/fpg-business-card-template.pdf');
    const pdfBytes = fs.readFileSync(templatePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Embed Helvetica standard fonts (no file needed)
    const fontBold = await pdfDoc.embedFont('Helvetica-Bold');
    const fontReg  = await pdfDoc.embedFont('Helvetica');

    const page = pdfDoc.getPages()[0];

    // Colours
    const darkBlue   = rgb(0/255, 55/255, 104/255);   // #003768
    const accentBlue = rgb(46/255, 153/255, 213/255);  // #2e99d5
    const darkGrey   = rgb(26/255, 42/255, 58/255);    // #1a2a3a

    // White out existing text areas
    page.drawRectangle({ x: 34, y: 33, width: 210, height: 52, color: rgb(1,1,1) });

    // Draw name
    page.drawText(name, { x: 36.9, y: 78.1, size: 15, font: fontBold, color: darkBlue });
    // Draw title
    page.drawText(title, { x: 36.9, y: 66.7, size: 7.5, font: fontReg, color: accentBlue });
    // Draw email
    page.drawText(email, { x: 36.9, y: 50.6, size: 8.5, font: fontReg, color: darkGrey });
    // Draw phone
    page.drawText(phone, { x: 36.9, y: 37.7, size: 8.5, font: fontReg, color: darkGrey });

    const modifiedBytes = await pdfDoc.save();
    const safeName = (name || 'business-card').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="FPG-Business-Card-${safeName}.pdf"`);
    res.send(Buffer.from(modifiedBytes));
  } catch (err) {
    console.error('Business card error:', err);
    res.status(500).send('Could not generate business card: ' + err.message);
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FPG Digital Asset Management Tool running on port ${PORT}`);
});
