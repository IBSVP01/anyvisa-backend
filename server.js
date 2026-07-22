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
    if (method === "GET" && pathname === "/api/auth/me") {
      return authRoutes.me(req, res);
    }
    if (method === "PATCH" && pathname === "/api/auth/me") {
      return authRoutes.updateMe(req, res, await readJsonBody(req));
    }
    if (method === "POST" && pathname === "/api/auth/change-password") {
      return authRoutes.changePassword(req, res, await readJsonBody(req));
    }
    if (method === "POST" && pathname === "/api/auth/logout") {
      return authRoutes.logout(req, res);
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
    if (method === "GET" && pathname === "/api/admin/applications") {
      return appRoutes.adminList(req, res);
    }
    const appIdMatch = pathname.match(/^\/api\/applications\/([^/]+)$/);
    if (appIdMatch && method === "PUT") {
      return appRoutes.update(req, res, await readJsonBody(req), decodeURIComponent(appIdMatch[1]));
    }
    if (appIdMatch && method === "DELETE") {
      return appRoutes.remove(req, res, decodeURIComponent(appIdMatch[1]));
    }
    const qMatch = pathname.match(/^\/api\/applications\/([^/]+)\/questionnaire$/);
    if (qMatch && method === "GET") {
      return appRoutes.getQuestionnaire(req, res, decodeURIComponent(qMatch[1]));
    }
    if (qMatch && method === "PUT") {
      return appRoutes.saveQuestionnaire(req, res, await readJsonBody(req), decodeURIComponent(qMatch[1]));
    }
    const adminQMatch = pathname.match(/^\/api\/admin\/applications\/([^/]+)\/questionnaire$/);
    if (adminQMatch && method === "GET") {
      return appRoutes.adminGetQuestionnaire(req, res, decodeURIComponent(adminQMatch[1]));
    }
    const bookingMatch = pathname.match(/^\/api\/admin\/applications\/([^/]+)\/booking$/);
    if (bookingMatch && method === "PUT") {
      return appRoutes.adminUpdateBooking(req, res, await readJsonBody(req), decodeURIComponent(bookingMatch[1]));
    }

    // ---- documents / AI review ----
    if (method === "POST" && pathname === "/api/documents/review") {
      return await docRoutes.reviewDocument(req, res, await readJsonBody(req));
    }
    if (method === "GET" && pathname === "/api/documents") {
      return docRoutes.listForApplication(req, res, url.searchParams.get("applicationId"));
    }
    if (method === "GET" && pathname === "/api/admin/documents/queue") {
      return docRoutes.adminQueue(req, res);
    }
    const resolveMatch = pathname.match(/^\/api\/admin\/documents\/([^/]+)\/resolve$/);
    if (resolveMatch && method === "POST") {
      return docRoutes.adminResolve(req, res, await readJsonBody(req), decodeURIComponent(resolveMatch[1]));
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
