// auth-routes.js
const crypto = require("node:crypto");
const db = require("./db");
const { hashPassword, verifyPassword, signToken, generateResetCode } = require("./auth-core");
const { sendJson, requireAuth, setSessionCookie, clearSessionCookie } = require("./http-helpers");
const { sendEmail, resetCodeEmail } = require("./email");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name || "", role: row.role };
}

function register(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim();

  if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: "Enter a valid email address." });
  if (password.length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters." });
  if (!name) return sendJson(res, 400, { error: "Enter your name." });

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) return sendJson(res, 409, { error: "An account with this email already exists." });

  const { hash, salt } = hashPassword(password);
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role) VALUES (?, ?, ?, ?, ?, 'customer')`
  ).run(id, email, name, hash, salt);

  const token = signToken({ sub: id, email, role: "customer" });
  setSessionCookie(res, token);
  sendJson(res, 201, { token, user: { id, email, name, role: "customer" } });
}

function login(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  const invalid = () => sendJson(res, 401, { error: "Incorrect email or password." });

  if (!user) return invalid();
  if (!verifyPassword(password, user.password_salt, user.password_hash)) return invalid();

  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  setSessionCookie(res, token);
  sendJson(res, 200, { token, user: publicUser(user) });
}

async function forgotPassword(req, res, body) {
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

    const { subject, html } = resetCodeEmail(code);
    try {
      const result = await sendEmail({ to: email, subject, html });
      if (!result.sent) console.log(`[auth] Reset code for ${email} (email not sent, see above): ${code}`);
    } catch (err) {
      console.error("[auth] sendEmail threw:", err.message);
      console.log(`[auth] Reset code for ${email} (email send failed): ${code}`);
    }
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
  setSessionCookie(res, token);
  sendJson(res, 200, { token, user: publicUser(user) });
}

// GET /api/auth/me — current user's profile.
function me(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(auth.sub);
  if (!user) return sendJson(res, 404, { error: "User not found." });
  sendJson(res, 200, publicUser(user));
}

// PATCH /api/auth/me — update name and/or email.
function updateMe(req, res, body) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(auth.sub);
  if (!user) return sendJson(res, 404, { error: "User not found." });

  const name = body.name !== undefined ? String(body.name).trim() : user.name;
  const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : user.email;

  if (!name) return sendJson(res, 400, { error: "Name can't be empty." });
  if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: "Enter a valid email address." });

  if (email !== user.email) {
    const clash = db.prepare(`SELECT id FROM users WHERE email = ? AND id != ?`).get(email, user.id);
    if (clash) return sendJson(res, 409, { error: "Another account already uses that email." });
  }

  db.prepare(`UPDATE users SET name = ?, email = ? WHERE id = ?`).run(name, email, user.id);
  const updated = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);

  // Email may have changed, so issue a fresh token with the new email in it.
  const token = signToken({ sub: updated.id, email: updated.email, role: updated.role });
  setSessionCookie(res, token);
  sendJson(res, 200, { token, user: publicUser(updated) });
}

// POST /api/auth/change-password — { currentPassword, newPassword }
function changePassword(req, res, body) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(auth.sub);
  if (!user) return sendJson(res, 404, { error: "User not found." });

  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");

  if (!verifyPassword(currentPassword, user.password_salt, user.password_hash)) {
    return sendJson(res, 401, { error: "Current password is incorrect." });
  }
  if (newPassword.length < 8) return sendJson(res, 400, { error: "New password must be at least 8 characters." });

  const { hash, salt } = hashPassword(newPassword);
  db.prepare(`UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`).run(hash, salt, user.id);
  sendJson(res, 200, { ok: true });
}

// POST /api/auth/logout — clears the session cookie.
function logout(req, res) {
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

module.exports = { register, login, forgotPassword, verifyCode, me, updateMe, changePassword, logout };
