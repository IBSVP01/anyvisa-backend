// lib/http.js
// Small helpers so the route handlers don't repeat boilerplate.
// No framework — this project intentionally has zero npm dependencies.

const { verifyToken } = require("./auth-core");
const db = require("./db");

const SESSION_COOKIE = "av_session";

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    const MAX_BODY = 10 * 1024 * 1024; // 10MB — generous enough for a base64 document photo
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  // Only set these two if writeHead hasn't already been called (e.g. by
  // setSessionCookie, which uses setHeader beforehand — that's fine, this
  // is the same call that actually sends the response).
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.writeHead(statusCode);
  res.end(body);
}

// Reflects the caller's exact origin (required for cookies to work
// cross-site — the wildcard "*" doesn't work once credentials are involved).
// Set ALLOWED_ORIGIN in your .env to your real GitHub Pages URL, e.g.
// https://yourusername.github.io — comma-separate multiple origins if needed.
function applyCors(req, res) {
  const configured = (process.env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  // Credentialed requests (cookies) can't use a wildcard origin — browsers
  // reject that combination outright. If ALLOWED_ORIGIN isn't set (or is
  // "*"), reflect back whatever origin actually made the request instead,
  // so cookie-based sessions work without forcing you to configure this
  // first. Once you know your real site's origin, set ALLOWED_ORIGIN to it
  // (comma-separate multiple) to lock this down for production.
  let allowOrigin;
  if (configured.length === 0 || configured.includes("*")) {
    allowOrigin = origin || "*";
  } else {
    allowOrigin = configured.includes(origin) ? origin : configured[0];
  }
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true; // caller should stop processing
  }
  return false;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

// Sets the session cookie so login survives a page reload without needing
// localStorage/sessionStorage. HttpOnly (JS can't read it — that's the
// point), Secure + SameSite=None so it works cross-site between GitHub
// Pages and this API's own domain.
function setSessionCookie(res, token) {
  const maxAgeSeconds = 60 * 60 * 24 * 7; // 7 days, matches the token's own expiry
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=None`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None`);
}

// Returns the decoded token payload from either an "Authorization: Bearer
// <token>" header (used right after login, while the JS still holds the
// token in memory) or the session cookie (used after a page reload, when
// the token has to come from somewhere the browser remembers on its own).
function getAuthUser(req) {
  const header = req.headers["authorization"] || "";
  const [scheme, headerToken] = header.split(" ");
  let payload = null;
  if (scheme === "Bearer" && headerToken) {
    payload = verifyToken(headerToken);
  }
  if (!payload) {
    const cookies = parseCookies(req);
    if (cookies[SESSION_COOKIE]) payload = verifyToken(cookies[SESSION_COOKIE]);
  }
  if (!payload) return null;

  // A cryptographically valid token can still point at a user that no
  // longer exists (e.g. the database was reset since the token was
  // issued). Confirm the user is actually still there before trusting it —
  // otherwise downstream inserts referencing this user_id via a foreign
  // key will crash instead of failing cleanly.
  const stillExists = db.prepare(`SELECT id FROM users WHERE id = ?`).get(payload.sub);
  if (!stillExists) return null;

  return payload;
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Not authenticated. Log in and try again." });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "Admin access required." });
    return null;
  }
  return user;
}

module.exports = {
  readJsonBody, sendJson, applyCors, getAuthUser, requireAuth, requireAdmin,
  setSessionCookie, clearSessionCookie
};
