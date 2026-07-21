// routes/applications.js
const crypto = require("node:crypto");
const db = require("./db");
const { sendJson, requireAuth } = require("./http-helpers");

function create(req, res, body) {
  const user = requireAuth(req, res);
  if (!user) return;

  const { countryId, purpose, travelers, departureDate, returnDate } = body;
  const country = db.prepare(`SELECT * FROM countries WHERE id = ?`).get(countryId);
  if (!country) return sendJson(res, 400, { error: "Unknown countryId." });
  if (!purpose) return sendJson(res, 400, { error: "purpose is required." });

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO applications (id, user_id, country_id, purpose, travelers, departure_date, return_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'documents_needed')`
  ).run(id, user.sub, countryId, purpose, Number(travelers) || 1, departureDate || null, returnDate || null);

  sendJson(res, 201, formatApplication(db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id), country));
}

function listMine(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  const rows = db.prepare(
    `SELECT a.*, c.name as country_name, c.government_fee, c.service_fee
     FROM applications a JOIN countries c ON c.id = a.country_id
     WHERE a.user_id = ? ORDER BY a.created_at DESC`
  ).all(user.sub);

  sendJson(res, 200, rows.map((r) => ({
    id: r.id,
    country: r.country_name,
    purpose: r.purpose,
    travelers: r.travelers,
    status: r.status,
    totalFee: r.government_fee + r.service_fee,
    createdAt: r.created_at,
    departureDate: r.departure_date,
    returnDate: r.return_date
  })));
}

function formatApplication(row, country) {
  return {
    id: row.id, country: country.name, purpose: row.purpose,
    travelers: row.travelers, status: row.status, createdAt: row.created_at,
    departureDate: row.departure_date, returnDate: row.return_date
  };
}

// DELETE /api/applications/:id — a customer can only delete their own.
function remove(req, res, id) {
  const user = requireAuth(req, res);
  if (!user) return;

  const application = db.prepare(`SELECT * FROM applications WHERE id = ? AND user_id = ?`).get(id, user.sub);
  if (!application) return sendJson(res, 404, { error: "Application not found." });

  db.prepare(`DELETE FROM documents WHERE application_id = ?`).run(id);
  db.prepare(`DELETE FROM applications WHERE id = ?`).run(id);
  sendJson(res, 200, { ok: true });
}

module.exports = { create, listMine, remove };
