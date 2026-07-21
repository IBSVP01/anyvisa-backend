// lib/http.js
// Small helpers so the route handlers don't repeat boilerplate.
// No framework — this project intentionally has zero npm dependencies.

const { verifyToken } = require("./auth-core");

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
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function applyCors(req, res) {
  // Adjust ALLOWED_ORIGIN in your .env once you know your GitHub Pages URL,
  // e.g. https://yourusername.github.io — avoid "*" once real user data is involved.
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true; // caller should stop processing
  }
  return false;
}

// Returns the decoded token payload if the request has a valid
// "Authorization: Bearer <token>" header, otherwise null.
function getAuthUser(req) {
  const header = req.headers["authorization"] || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return verifyToken(token);
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Not authenticated. Log in and include the token as: Authorization: Bearer <token>" });
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

module.exports = { readJsonBody, sendJson, applyCors, getAuthUser, requireAuth, requireAdmin };
