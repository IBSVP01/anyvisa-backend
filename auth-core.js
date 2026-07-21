// lib/auth.js
// Password hashing (scrypt) and signed session tokens (HMAC-SHA256, JWT-shaped).
// No dependencies — everything here is Node's built-in `crypto` module.

const crypto = require("node:crypto");

const TOKEN_SECRET = process.env.TOKEN_SECRET;
if (!TOKEN_SECRET) {
  // Fail loudly rather than silently running with a guessable default secret.
  throw new Error(
    "TOKEN_SECRET environment variable is not set. Generate one with:\n" +
    "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
    "and set it in your .env file before starting the server."
  );
}

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b); // constant-time compare, avoids timing attacks
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

// Minimal JWT-shaped token: header.payload.signature, HMAC-SHA256.
// This is structurally a real JWT (HS256) — just hand-rolled instead of
// pulling in the `jsonwebtoken` package, since this project has zero deps.
function signToken(payload, expiresInSeconds = 60 * 60 * 24 * 7) {
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const headerB64 = base64url(JSON.stringify(header));
  const bodyB64 = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(`${headerB64}.${bodyB64}`)
    .digest("base64url");
  return `${headerB64}.${bodyB64}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, bodyB64, signature] = parts;
  const expected = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(`${headerB64}.${bodyB64}`)
    .digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null; // expired
  return payload;
}

function generateResetCode() {
  // 6-digit numeric code, e.g. "042917"
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, generateResetCode };
