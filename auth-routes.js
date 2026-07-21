// routes/auth.js
const crypto = require("node:crypto");
const db = require("./db");
const { hashPassword, verifyPassword, signToken, generateResetCode } = require("./auth-core");
const { sendJson } = require("./http-helpers");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function register(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: "Enter a valid email address." });
  if (password.length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters." });

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) return sendJson(res, 409, { error: "An account with this email already exists." });

  const { hash, salt } = hashPassword(password);
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, role) VALUES (?, ?, ?, ?, 'customer')`
  ).run(id, email, hash, salt);

  const token = signToken({ sub: id, email, role: "customer" });
  sendJson(res, 201, { token, user: { id, email, role: "customer" } });
}

function login(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  // Same error for "no such user" and "wrong password" — don't leak which one it was.
  const invalid = () => sendJson(res, 401, { error: "Incorrect email or password." });

  if (!user) return invalid();
  if (!verifyPassword(password, user.password_salt, user.password_hash)) return invalid();

  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  sendJson(res, 200, { token, user: { id: user.id, email: user.email, role: user.role } });
}

function forgotPassword(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: "Enter a valid email address." });

  // Always respond the same way whether or not the account exists, so this
  // endpoint can't be used to check which emails are registered.
  const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (user) {
    const code = generateResetCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes
    db.prepare(
      `INSERT INTO reset_codes (email, code, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at`
    ).run(email, code, expiresAt);

    // TODO: send a real email via Postmark/SendGrid/SES here. For now this
    // logs the code server-side so you can test the flow end to end.
    console.log(`[auth] Password reset code for ${email}: ${code} (expires ${expiresAt})`);
  }

  sendJson(res, 200, { ok: true, message: "If that email is registered, a code has been sent." });
}

function verifyCode(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();
  const newPassword = body.newPassword ? String(body.newPassword) : null;

  const row = db.prepare(`SELECT * FROM reset_codes WHERE email = ?`).get(email);
  if (!row || row.code !== code) return sendJson(res, 400, { error: "That code is incorrect." });
  if (new Date(row.expires_at) < new Date()) return sendJson(res, 400, { error: "That code has expired. Request a new one." });

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!user) return sendJson(res, 404, { error: "No account found for this email." });

  if (newPassword) {
    if (newPassword.length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters." });
    const { hash, salt } = hashPassword(newPassword);
    db.prepare(`UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`).run(hash, salt, user.id);
  }

  db.prepare(`DELETE FROM reset_codes WHERE email = ?`).run(email); // one-time use

  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  sendJson(res, 200, { token, user: { id: user.id, email: user.email, role: user.role } });
}

module.exports = { register, login, forgotPassword, verifyCode };
