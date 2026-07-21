# AnyVisa backend

A real API for the AnyVisa site: password-based auth (with email-code password
reset), country/pricing management, and AI document review via the Anthropic
API.

**Zero npm dependencies.** Everything uses Node's built-ins: `http` for the
server, `node:sqlite` for the database, `crypto` for password hashing
(scrypt) and signed session tokens. Run with `node server.js` — no
`npm install` step, nothing to compile.

Requires **Node 22.5+** (for built-in SQLite). Check with `node --version`.

## What's actually implemented (tested end to end)

- `POST /api/auth/register` — email + password, scrypt-hashed, returns a session token
- `POST /api/auth/login`
- `POST /api/auth/forgot` — generates a 6-digit code (10 min expiry), currently logs it server-side (see "Wire up real email" below)
- `POST /api/auth/verify-code` — checks the code, optionally sets a new password, logs you in
- `GET /api/countries` — public list, used by the site instead of a hardcoded list
- `POST /api/admin/countries`, `PUT /api/admin/countries/:id`, `DELETE /api/admin/countries/:id` — admin-only, requires a token with `role: "admin"`
- `POST /api/applications`, `GET /api/applications` — a logged-in user's visa applications
- `POST /api/documents/review` — sends an uploaded document image to Claude for a pass/needs-review/fail verdict, stores the result
- `GET /api/documents?applicationId=...` — a given application's document review status

Every one of the above was tested with real `curl` requests against a running
instance, including the failure paths (wrong password, missing auth, non-admin
trying an admin action, duplicate email).

## Run it locally

```bash
cp .env.example .env
# generate a real secret:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# paste it into .env as TOKEN_SECRET=...
# also set ADMIN_PASSWORD to something real, and ANTHROPIC_API_KEY if you want
# document review to actually work

node server.js
# → AnyVisa API listening on http://localhost:3000
```

Try it: `curl http://localhost:3000/api/health`

## Deploying somewhere real

GitHub Pages (where the front-end lives) **cannot run this** — it only
serves static files. This needs an actual host that keeps a Node process
running. All of these have a free tier and support this zero-dependency
style project with no extra config:

### Render (recommended — simplest)
1. Push this `anyvisa-backend` folder to its own GitHub repo (or a subfolder of one).
2. [render.com](https://render.com) → New → Web Service → connect the repo.
3. Build command: (leave empty — nothing to build)
4. Start command: `node server.js`
5. Add environment variables in the Render dashboard (same names as `.env.example`): `TOKEN_SECRET`, `ANTHROPIC_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ALLOWED_ORIGIN` (set this to your GitHub Pages URL once deployed).
6. **Important**: Render's free tier has an ephemeral filesystem — the SQLite file will reset on redeploy. For anything beyond testing, attach a Render persistent disk (small extra cost) mounted at e.g. `/data`, and set `DB_PATH=/data/anyvisa.db` in the environment variables.

### Railway / Fly.io
Same idea — connect the repo, set the start command to `node server.js`, add
the same environment variables. Both offer volumes for persistent SQLite
storage (check their current free-tier terms, they change).

### Your own VPS
```bash
git clone <your-repo>
cd anyvisa-backend
cp .env.example .env   # fill in real values
node server.js
```
Keep it running with `pm2 start server.js --name anyvisa-api` or a systemd
service, and put it behind Nginx/Caddy for HTTPS.

## After deploying: connect the front-end

Once you have a live URL (e.g. `https://anyvisa-api.onrender.com`), the
`index.html` and `admin.html` front-end files need to be pointed at it —
right now they still use the in-browser demo data from earlier prototyping.
Send me the URL and I'll wire:
- the hero "Get Visa" checker and pricing card to `GET /api/countries`
- the login/register/forgot-password modal to the real `/api/auth/*` endpoints
- the wizard's final submit to `POST /api/applications`
- the document upload buttons to `POST /api/documents/review`
- `admin.html`'s pricing table to the real `/api/admin/countries` endpoints, and add a login gate for admin.html itself (it currently has none — don't rely on "no one will find the URL" as security)

## Security notes — read before going live

- **`admin.html` has no login screen yet.** The API correctly rejects
  non-admin tokens, but the page itself doesn't ask anyone to sign in. Don't
  publish its URL anywhere until that's added.
- **CORS defaults to `*`** (any site can call the API) until you set
  `ALLOWED_ORIGIN`. Set it to your real site's origin before going live.
- **Rate limiting isn't implemented.** `/api/auth/login` and
  `/api/auth/forgot` in particular should be rate-limited per IP/email before
  this handles real traffic, or it's an easy target for password-guessing /
  spam.
- **Reset codes are logged to the console, not emailed.** Wire up a real
  provider (Postmark, SendGrid, AWS SES) in `auth-routes.js` →
  `forgotPassword()` before this is usable by real customers.
- SQLite is genuinely fine at this scale (thousands of users) — you don't
  need Postgres until you outgrow a single server, which is a good problem
  to have later, not now.
