# FPG Brand Hub

A password-gated brand asset repository for Finance Planning Group. Hosts downloadable logos, templates, social media assets and brand guidelines, with built-in colour/typography specs and social post examples.

---

## Stack

- **Node.js + Express** — server and session-based auth
- **Vanilla HTML/CSS/JS** — no build step, deploys instantly
- **Railway** — hosting
- **GitHub** — source control and Railway deployment trigger

---

## Local Development

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_ORG/fpg-brand-hub.git
cd fpg-brand-hub

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env — set BRAND_HUB_PASSWORD and SESSION_SECRET

# 4. Start dev server
npm run dev

# 5. Open http://localhost:3000
```

---

## Deploying to Railway

### First deploy

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) and click **New Project**
3. Choose **Deploy from GitHub repo** and select this repo
4. Railway will detect Node.js automatically
5. Go to **Variables** in your Railway project and add:

| Variable | Value |
|---|---|
| `BRAND_HUB_PASSWORD` | Your chosen access password |
| `SESSION_SECRET` | A long random string (32+ chars) |

6. Railway will deploy automatically. Your app will be live at the Railway-provided URL.

### Subsequent deploys

Push to your main branch. Railway redeploys automatically.

### Custom domain

In Railway: **Settings > Domains > Add Custom Domain**. Point your DNS CNAME to the Railway URL.

---

## Adding Assets

Assets live in `public/assets/` in four subfolders:

```
public/assets/
  logos/          <- logo files (.ai, .eps, .svg, .png, .jpg)
  templates/      <- PowerPoint, letterhead, email signatures
  social/         <- page headers, profile images, template packs
  guidelines/     <- brand guidelines PDF
```

### To add a file

1. Drop the file into the correct subfolder
2. The filename must exactly match the href in `public/index.html`

Expected filenames are listed in the table below. You can also add extra files — the frontend will pick them up automatically via the `/api/assets` endpoint.

### Expected filenames

| Folder | Filename |
|---|---|
| `logos` | `fpg-logo-master.ai` |
| `logos` | `fpg-logo.eps` |
| `logos` | `fpg-logo.svg` |
| `logos` | `fpg-logo-transparent.png` |
| `logos` | `fpg-logo-reversed.png` |
| `logos` | `fpg-logo-email.jpg` |
| `templates` | `fpg-presentation-template.pptx` |
| `templates` | `fpg-letterhead.pdf` |
| `templates` | `fpg-email-signatures.zip` |
| `social` | `fpg-linkedin-header.png` |
| `social` | `fpg-facebook-cover.png` |
| `social` | `fpg-instagram-profile.png` |
| `social` | `fpg-social-templates.zip` |
| `guidelines` | `FPG_Brand_Guidelines.pdf` |

Once a file is present, its download button activates automatically and the badge updates to "Ready".

### Adding the brand guidelines PDF

Copy the generated PDF into the guidelines folder:

```bash
cp /path/to/FPG_Brand_Guidelines.pdf public/assets/guidelines/
```

---

## Changing the Password

Update `BRAND_HUB_PASSWORD` in Railway's environment variables. Sessions expire after 8 hours by default.

To change session duration, edit `server.js`:

```js
cookie: { maxAge: 1000 * 60 * 60 * 8 } // change 8 to desired hours
```

---

## Project Structure

```
fpg-brand-hub/
  server.js               <- Express app, auth, download routes
  package.json
  .env.example            <- Copy to .env for local dev
  .gitignore
  public/
    login.html            <- Password gate page
    index.html            <- Main brand hub SPA
    static/               <- Unprotected static files (favicon etc)
    assets/
      logos/
      templates/
      social/
      guidelines/
  README.md
```

---

## Security Notes

- Never commit `.env` to git — it is in `.gitignore`
- Set a strong `SESSION_SECRET` in production (Railway env vars)
- All asset downloads are gated behind the session check
- Path traversal is sanitised in the download route

---

## Contact

Brand team: contact via FPG internal channels.
