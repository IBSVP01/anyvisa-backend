// server.js
// Entry point. Plain Node `http` server — no Express, no dependencies at all.
// Run with: node server.js   (after copying .env.example to .env and filling it in)

require("./env-loader")(); // loads .env without needing the `dotenv` package

const http = require("node:http");
const { readJsonBody, sendJson, applyCors } = require("./http-helpers");
const authRoutes = require("./auth-routes");
const countryRoutes = require("./countries-routes");
const appRoutes = require("./applications-routes");
const docRoutes = require("./documents-routes");

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  if (applyCors(req, res)) return; // handled an OPTIONS preflight request

  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  try {
    // ---- health check ----
    if (method === "GET" && pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    // ---- auth ----
    if (method === "POST" && pathname === "/api/auth/register") {
      return authRoutes.register(req, res, await readJsonBody(req));
    }
    if (method === "POST" && pathname === "/api/auth/login") {
      return authRoutes.login(req, res, await readJsonBody(req));
    }
    if (method === "POST" && pathname === "/api/auth/forgot") {
      return authRoutes.forgotPassword(req, res, await readJsonBody(req));
    }
    if (method === "POST" && pathname === "/api/auth/verify-code") {
      return authRoutes.verifyCode(req, res, await readJsonBody(req));
    }

    // ---- countries (public read, admin write) ----
    if (method === "GET" && pathname === "/api/countries") {
      return countryRoutes.list(req, res);
    }
    if (method === "POST" && pathname === "/api/admin/countries") {
      return countryRoutes.create(req, res, await readJsonBody(req));
    }
    const countryIdMatch = pathname.match(/^\/api\/admin\/countries\/([^/]+)$/);
    if (countryIdMatch && method === "PUT") {
      return countryRoutes.update(req, res, await readJsonBody(req), decodeURIComponent(countryIdMatch[1]));
    }
    if (countryIdMatch && method === "DELETE") {
      return countryRoutes.remove(req, res, decodeURIComponent(countryIdMatch[1]));
    }

    // ---- applications ----
    if (method === "POST" && pathname === "/api/applications") {
      return appRoutes.create(req, res, await readJsonBody(req));
    }
    if (method === "GET" && pathname === "/api/applications") {
      return appRoutes.listMine(req, res);
    }

    // ---- documents / AI review ----
    if (method === "POST" && pathname === "/api/documents/review") {
      return await docRoutes.reviewDocument(req, res, await readJsonBody(req));
    }
    if (method === "GET" && pathname === "/api/documents") {
      return docRoutes.listForApplication(req, res, url.searchParams.get("applicationId"));
    }

    // ---- not found ----
    sendJson(res, 404, { error: "Not found." });
  } catch (err) {
    console.error("[server] Unhandled error:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`AnyVisa API listening on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/api/health`);
});
