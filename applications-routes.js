// applications-routes.js
const crypto = require("node:crypto");
const db = require("./db");
const { sendJson, requireAuth, requireAdmin } = require("./http-helpers");

// ---------------- customer-facing ----------------

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

  // Every application gets an empty questionnaire row up front, so it's
  // always safe to UPDATE later instead of juggling insert-vs-update logic.
  db.prepare(`INSERT INTO questionnaires (application_id) VALUES (?)`).run(id);

  const created = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id);
  sendJson(res, 201, formatApplication(created, country));
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
    countryId: r.country_id,
    country: r.country_name,
    purpose: r.purpose,
    travelers: r.travelers,
    status: r.status,
    totalFee: r.government_fee + r.service_fee,
    createdAt: r.created_at,
    departureDate: r.departure_date,
    returnDate: r.return_date,
    bookingStatus: r.booking_status,
    appointmentAt: r.appointment_at
  })));
}

// PUT /api/applications/:id — a customer can edit their own trip details.
function update(req, res, body, id) {
  const user = requireAuth(req, res);
  if (!user) return;

  const application = db.prepare(`SELECT * FROM applications WHERE id = ? AND user_id = ?`).get(id, user.sub);
  if (!application) return sendJson(res, 404, { error: "Application not found." });

  const purpose = body.purpose !== undefined ? String(body.purpose) : application.purpose;
  const travelers = body.travelers !== undefined ? Number(body.travelers) : application.travelers;
  const departureDate = body.departureDate !== undefined ? body.departureDate : application.departure_date;
  const returnDate = body.returnDate !== undefined ? body.returnDate : application.return_date;

  if (!purpose) return sendJson(res, 400, { error: "purpose can't be empty." });
  if (!Number.isFinite(travelers) || travelers < 1) return sendJson(res, 400, { error: "travelers must be at least 1." });

  db.prepare(
    `UPDATE applications SET purpose = ?, travelers = ?, departure_date = ?, return_date = ? WHERE id = ?`
  ).run(purpose, travelers, departureDate || null, returnDate || null, id);

  const country = db.prepare(`SELECT * FROM countries WHERE id = ?`).get(application.country_id);
  const updated = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id);
  sendJson(res, 200, formatApplication(updated, country));
}

// DELETE /api/applications/:id — a customer can only delete their own.
function remove(req, res, id) {
  const user = requireAuth(req, res);
  if (!user) return;

  const application = db.prepare(`SELECT * FROM applications WHERE id = ? AND user_id = ?`).get(id, user.sub);
  if (!application) return sendJson(res, 404, { error: "Application not found." });

  db.prepare(`DELETE FROM documents WHERE application_id = ?`).run(id);
  db.prepare(`DELETE FROM questionnaires WHERE application_id = ?`).run(id);
  db.prepare(`DELETE FROM applications WHERE id = ?`).run(id);
  sendJson(res, 200, { ok: true });
}

// GET /api/applications/:id/questionnaire
function getQuestionnaire(req, res, id) {
  const user = requireAuth(req, res);
  if (!user) return;

  const application = db.prepare(`SELECT id FROM applications WHERE id = ? AND user_id = ?`).get(id, user.sub);
  if (!application) return sendJson(res, 404, { error: "Application not found." });

  const q = db.prepare(`SELECT * FROM questionnaires WHERE application_id = ?`).get(id);
  sendJson(res, 200, formatQuestionnaire(q));
}

// PUT /api/applications/:id/questionnaire
function saveQuestionnaire(req, res, body, id) {
  const user = requireAuth(req, res);
  if (!user) return;

  const application = db.prepare(`SELECT id FROM applications WHERE id = ? AND user_id = ?`).get(id, user.sub);
  if (!application) return sendJson(res, 404, { error: "Application not found." });

  const fields = [
    "fullName", "dateOfBirth", "passportNumber", "passportIssueDate", "passportExpiryDate",
    "nationality", "address", "phone", "occupation", "employer", "previousRefusal", "previousRefusalDetails"
  ];
  const columnFor = {
    fullName: "full_name", dateOfBirth: "date_of_birth", passportNumber: "passport_number",
    passportIssueDate: "passport_issue_date", passportExpiryDate: "passport_expiry_date",
    nationality: "nationality", address: "address", phone: "phone", occupation: "occupation",
    employer: "employer", previousRefusal: "previous_refusal", previousRefusalDetails: "previous_refusal_details"
  };

  const existing = db.prepare(`SELECT * FROM questionnaires WHERE application_id = ?`).get(id);
  const setClauses = [];
  const values = [];
  fields.forEach((f) => {
    const col = columnFor[f];
    const value = body[f] !== undefined ? String(body[f]) : (existing ? existing[col] : "");
    setClauses.push(`${col} = ?`);
    values.push(value);
  });
  values.push(id);

  if (existing) {
    db.prepare(`UPDATE questionnaires SET ${setClauses.join(", ")}, updated_at = datetime('now') WHERE application_id = ?`).run(...values);
  } else {
    db.prepare(`INSERT INTO questionnaires (application_id) VALUES (?)`).run(id);
    db.prepare(`UPDATE questionnaires SET ${setClauses.join(", ")}, updated_at = datetime('now') WHERE application_id = ?`).run(...values);
  }

  const q = db.prepare(`SELECT * FROM questionnaires WHERE application_id = ?`).get(id);
  sendJson(res, 200, formatQuestionnaire(q));
}

function formatApplication(row, country) {
  return {
    id: row.id, countryId: country.id, country: country.name, purpose: row.purpose,
    travelers: row.travelers, status: row.status, createdAt: row.created_at,
    departureDate: row.departure_date, returnDate: row.return_date,
    bookingStatus: row.booking_status, appointmentAt: row.appointment_at
  };
}

function formatQuestionnaire(q) {
  if (!q) {
    return {
      fullName: "", dateOfBirth: "", passportNumber: "", passportIssueDate: "", passportExpiryDate: "",
      nationality: "", address: "", phone: "", occupation: "", employer: "",
      previousRefusal: "", previousRefusalDetails: "", complete: false
    };
  }
  const complete = !!(q.full_name && q.date_of_birth && q.passport_number && q.passport_expiry_date && q.nationality);
  return {
    fullName: q.full_name, dateOfBirth: q.date_of_birth, passportNumber: q.passport_number,
    passportIssueDate: q.passport_issue_date, passportExpiryDate: q.passport_expiry_date,
    nationality: q.nationality, address: q.address, phone: q.phone, occupation: q.occupation,
    employer: q.employer, previousRefusal: q.previous_refusal, previousRefusalDetails: q.previous_refusal_details,
    complete: complete, updatedAt: q.updated_at
  };
}

// ---------------- admin-facing ----------------
// This is how AnyVisa staff see the questionnaire data and manually track
// booking a real appointment (the booking itself happens on the actual
// consulate/visa-centre website — this just tracks status/notes for it).

// GET /api/admin/applications — every application, every customer.
function adminList(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rows = db.prepare(
    `SELECT a.*, c.name as country_name, u.email as user_email, u.name as user_name,
            q.full_name as q_full_name, q.passport_number as q_passport_number
     FROM applications a
     JOIN countries c ON c.id = a.country_id
     JOIN users u ON u.id = a.user_id
     LEFT JOIN questionnaires q ON q.application_id = a.id
     ORDER BY a.created_at DESC`
  ).all();

  sendJson(res, 200, rows.map((r) => ({
    id: r.id, country: r.country_name, purpose: r.purpose, travelers: r.travelers,
    status: r.status, createdAt: r.created_at, departureDate: r.departure_date, returnDate: r.return_date,
    bookingStatus: r.booking_status, bookingNotes: r.booking_notes, appointmentAt: r.appointment_at,
    userEmail: r.user_email, userName: r.user_name,
    questionnaireComplete: !!(r.q_full_name && r.q_passport_number)
  })));
}

// GET /api/admin/applications/:id/questionnaire
function adminGetQuestionnaire(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const q = db.prepare(`SELECT * FROM questionnaires WHERE application_id = ?`).get(id);
  sendJson(res, 200, formatQuestionnaire(q));
}

// PUT /api/admin/applications/:id/booking — { bookingStatus, bookingNotes, appointmentAt }
function adminUpdateBooking(req, res, body, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const application = db.prepare(`SELECT id FROM applications WHERE id = ?`).get(id);
  if (!application) return sendJson(res, 404, { error: "Application not found." });

  const bookingStatus = ["not_booked", "booked"].includes(body.bookingStatus) ? body.bookingStatus : "not_booked";
  const bookingNotes = String(body.bookingNotes || "");
  const appointmentAt = body.appointmentAt || null;

  db.prepare(
    `UPDATE applications SET booking_status = ?, booking_notes = ?, appointment_at = ?,
     status = CASE WHEN ? = 'booked' THEN 'filed' ELSE status END
     WHERE id = ?`
  ).run(bookingStatus, bookingNotes, appointmentAt, bookingStatus, id);

  sendJson(res, 200, { ok: true });
}

module.exports = {
  create, listMine, update, remove,
  getQuestionnaire, saveQuestionnaire,
  adminList, adminGetQuestionnaire, adminUpdateBooking
};
