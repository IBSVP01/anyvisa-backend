// routes/countries.js
const crypto = require("node:crypto");
const db = require("./db");
const { sendJson, requireAdmin } = require("./http-helpers");

// Public: GET /api/countries — the live site fetches this instead of using
// the hardcoded DEST object in the front-end JS.
function list(req, res) {
  const rows = db.prepare(`SELECT * FROM countries ORDER BY name ASC`).all();
  sendJson(res, 200, rows.map(formatCountry));
}

// Admin: POST /api/admin/countries — add a new destination.
function create(req, res, body) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const name = String(body.name || "").trim();
  const governmentFee = Number(body.governmentFee);
  const serviceFee = Number(body.serviceFee ?? 69);
  const isEvisa = body.isEvisa ? 1 : 0;
  const note = String(body.note || "");

  if (!name) return sendJson(res, 400, { error: "Country name is required." });
  if (!Number.isFinite(governmentFee) || governmentFee < 0) {
    return sendJson(res, 400, { error: "governmentFee must be a non-negative number." });
  }

  const existing = db.prepare(`SELECT id FROM countries WHERE name = ?`).get(name);
  if (existing) return sendJson(res, 409, { error: "A country with this name already exists." });

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || crypto.randomUUID();
  db.prepare(
    `INSERT INTO countries (id, name, government_fee, service_fee, is_evisa, note) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, name, governmentFee, serviceFee, isEvisa, note);

  sendJson(res, 201, formatCountry(db.prepare(`SELECT * FROM countries WHERE id = ?`).get(id)));
}

// Admin: PUT /api/admin/countries/:id — edit fees/details.
function update(req, res, body, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const existing = db.prepare(`SELECT * FROM countries WHERE id = ?`).get(id);
  if (!existing) return sendJson(res, 404, { error: "Country not found." });

  const governmentFee = body.governmentFee !== undefined ? Number(body.governmentFee) : existing.government_fee;
  const serviceFee = body.serviceFee !== undefined ? Number(body.serviceFee) : existing.service_fee;
  const isEvisa = body.isEvisa !== undefined ? (body.isEvisa ? 1 : 0) : existing.is_evisa;
  const note = body.note !== undefined ? String(body.note) : existing.note;

  if (!Number.isFinite(governmentFee) || governmentFee < 0) {
    return sendJson(res, 400, { error: "governmentFee must be a non-negative number." });
  }

  db.prepare(
    `UPDATE countries SET government_fee = ?, service_fee = ?, is_evisa = ?, note = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(governmentFee, serviceFee, isEvisa, note, id);

  sendJson(res, 200, formatCountry(db.prepare(`SELECT * FROM countries WHERE id = ?`).get(id)));
}

// Admin: DELETE /api/admin/countries/:id
function remove(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const existing = db.prepare(`SELECT id FROM countries WHERE id = ?`).get(id);
  if (!existing) return sendJson(res, 404, { error: "Country not found." });

  db.prepare(`DELETE FROM countries WHERE id = ?`).run(id);
  sendJson(res, 200, { ok: true });
}

function formatCountry(row) {
  return {
    id: row.id,
    name: row.name,
    governmentFee: row.government_fee,
    serviceFee: row.service_fee,
    isEvisa: !!row.is_evisa,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

module.exports = { list, create, update, remove };
