// countries-routes.js
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

  const created = db.prepare(`SELECT * FROM countries WHERE id = ?`).get(id);
  sendJson(res, 201, formatCountry(created));
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

  const updated = db.prepare(`SELECT * FROM countries WHERE id = ?`).get(id);
  sendJson(res, 200, formatCountry(updated));
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

// Public: GET /api/countries/:id/documents — the specific document
// checklist for this destination (what the wizard/dashboard shows).
function listDocuments(req, res, id) {
  const country = db.prepare(`SELECT id FROM countries WHERE id = ?`).get(id);
  if (!country) return sendJson(res, 404, { error: "Country not found." });

  const rows = db.prepare(`SELECT * FROM country_documents WHERE country_id = ? ORDER BY sort_order ASC`).all(id);
  sendJson(res, 200, rows.map(formatCountryDoc));
}

// Admin: POST /api/admin/countries/:id/documents — add a document requirement.
function addDocument(req, res, body, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const country = db.prepare(`SELECT id FROM countries WHERE id = ?`).get(id);
  if (!country) return sendJson(res, 404, { error: "Country not found." });

  const docType = String(body.docType || "").trim();
  const docName = String(body.docName || "").trim();
  const docSub = String(body.docSub || "");
  const aiRule = String(body.aiRule || "").trim();

  if (!docType || !docName || !aiRule) {
    return sendJson(res, 400, { error: "docType, docName and aiRule are required." });
  }

  const existing = db.prepare(`SELECT id FROM country_documents WHERE country_id = ? AND doc_type = ?`).get(id, docType);
  if (existing) return sendJson(res, 409, { error: "This document type already exists for this country — edit it instead." });

  const maxOrder = db.prepare(`SELECT MAX(sort_order) as m FROM country_documents WHERE country_id = ?`).get(id);
  const sortOrder = (maxOrder && maxOrder.m !== null ? maxOrder.m : -1) + 1;
  const docId = `${id}-${docType}`;

  db.prepare(
    `INSERT INTO country_documents (id, country_id, doc_type, doc_name, doc_sub, ai_rule, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(docId, id, docType, docName, docSub, aiRule, sortOrder);

  sendJson(res, 201, formatCountryDoc(db.prepare(`SELECT * FROM country_documents WHERE id = ?`).get(docId)));
}

// Admin: PUT /api/admin/countries/:id/documents/:docId — edit one document requirement.
function updateDocument(req, res, body, id, docId) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const existing = db.prepare(`SELECT * FROM country_documents WHERE id = ? AND country_id = ?`).get(docId, id);
  if (!existing) return sendJson(res, 404, { error: "Document requirement not found." });

  const docName = body.docName !== undefined ? String(body.docName) : existing.doc_name;
  const docSub = body.docSub !== undefined ? String(body.docSub) : existing.doc_sub;
  const aiRule = body.aiRule !== undefined ? String(body.aiRule) : existing.ai_rule;

  if (!docName || !aiRule) return sendJson(res, 400, { error: "docName and aiRule can't be empty." });

  db.prepare(`UPDATE country_documents SET doc_name = ?, doc_sub = ?, ai_rule = ? WHERE id = ?`).run(docName, docSub, aiRule, docId);
  sendJson(res, 200, formatCountryDoc(db.prepare(`SELECT * FROM country_documents WHERE id = ?`).get(docId)));
}

// Admin: DELETE /api/admin/countries/:id/documents/:docId
function removeDocument(req, res, id, docId) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const existing = db.prepare(`SELECT id FROM country_documents WHERE id = ? AND country_id = ?`).get(docId, id);
  if (!existing) return sendJson(res, 404, { error: "Document requirement not found." });

  db.prepare(`DELETE FROM country_documents WHERE id = ?`).run(docId);
  sendJson(res, 200, { ok: true });
}

function formatCountryDoc(row) {
  return {
    id: row.id, docType: row.doc_type, docName: row.doc_name,
    docSub: row.doc_sub, aiRule: row.ai_rule, sortOrder: row.sort_order
  };
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

module.exports = { list, create, update, remove, listDocuments, addDocument, updateDocument, removeDocument };
