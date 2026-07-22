// routes/documents.js
// Real AI document review, calling the Anthropic API from the server.
// The API key NEVER goes to the browser — that's the entire point of this
// living on the backend instead of being called directly from the site's JS.

const crypto = require("node:crypto");
const db = require("./db");
const { sendJson, requireAuth, requireAdmin } = require("./http-helpers");

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

// What the model is asked to check, per document type. Keep this editable —
// it's the actual "business logic" of the review and will need real
// immigration-law input, not just an engineering guess.
//
// Note on "sufficient funds": whether a balance is "enough" depends on the
// destination consulate's actual rules (which vary a lot and this system
// doesn't encode), so the model is asked to flag amounts that look clearly
// too low for the trip for a human to judge — not to hard-fail on its own
// guess at a threshold.
const DOC_RULES = {
  "passport-bio-page": "Check: passport is valid at least 6 months beyond the trip's return date, has at least one blank visa page, the photo page is fully visible and not glare-obscured, and the document doesn't appear to be expired, damaged, or altered.",
  "passport-photo": "Check: a single passport-style photo, plain light background, face fully visible (no sunglasses/hat), roughly passport-photo proportions (not a full-body or group photo).",
  "proof-of-address": "Check: a utility bill or bank statement showing a name and address, dated within the last 3 months of today's date.",
  "bank-statement": "Check TWO things: (1) the statement's date — it must be within the last 3 months of today's date, state clearly by how many months it's outside that window if not; (2) if trip dates are provided below, whether the closing balance looks reasonable for that trip length and destination (a very rough rule of thumb: at least ~£50–100/day per traveler for the trip duration) — if it looks low, say so as something for a human to judge, don't hard-fail on this alone.",
  "travel-insurance": "Check: a travel/medical insurance document showing coverage dates and a minimum medical coverage amount (flag if coverage looks below roughly €30,000 or isn't stated), and whether the coverage dates actually span the trip dates given below, if provided.",
  "invitation-letter": "Check: an invitation or business letter, on what appears to be letterhead, naming the applicant and travel dates."
};

async function reviewDocument(req, res, body) {
  const user = requireAuth(req, res);
  if (!user) return;

  if (!process.env.GOOGLE_API_KEY) {
    return sendJson(res, 500, {
      error: "AI review isn't configured on this server. Set GOOGLE_API_KEY in your .env file."
    });
  }

  const { applicationId, docType, imageBase64, mimeType } = body;
  if (!applicationId || !docType || !imageBase64) {
    return sendJson(res, 400, { error: "applicationId, docType and imageBase64 are required." });
  }
  const rule = DOC_RULES[docType];
  if (!rule) {
    return sendJson(res, 400, { error: `Unknown docType "${docType}". Known types: ${Object.keys(DOC_RULES).join(", ")}` });
  }
  const effectiveMime = mimeType || "image/jpeg";
  if (!ALLOWED_MIME_TYPES.includes(effectiveMime)) {
    return sendJson(res, 400, { error: `Unsupported file type "${effectiveMime}". Allowed: ${ALLOWED_MIME_TYPES.join(", ")}` });
  }

  const application = db.prepare(
    `SELECT a.*, c.name as country_name FROM applications a JOIN countries c ON c.id = a.country_id
     WHERE a.id = ? AND a.user_id = ?`
  ).get(applicationId, user.sub);
  if (!application) return sendJson(res, 404, { error: "Application not found for this user." });

  let aiResult;
  try {
    aiResult = await callGeminiVision({
      rule,
      imageBase64,
      mimeType: effectiveMime,
      trip: {
        country: application.country_name,
        purpose: application.purpose,
        travelers: application.travelers,
        departureDate: application.departure_date,
        returnDate: application.return_date
      }
    });
  } catch (err) {
    console.error("[documents] AI review call failed:", err.message);
    return sendJson(res, 502, { error: "The AI review service failed. Try again in a moment." });
  }

  const docId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO documents (id, application_id, doc_type, ai_status, ai_reason, ai_fix) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(docId, applicationId, docType, aiResult.status, aiResult.reason, aiResult.fix);

  sendJson(res, 200, { id: docId, status: aiResult.status, reason: aiResult.reason, fix: aiResult.fix });
}

// Calls the real Google Gemini API with the uploaded file (image or PDF —
// Gemini takes both the same way, as inline_data) and asks for a
// strict-JSON verdict. Uses global fetch (built into Node 18+) — no SDK
// dependency needed for a single endpoint like this.
async function callGeminiVision({ rule, imageBase64, mimeType, trip }) {
  var tripLines = [];
  if (trip.country) tripLines.push("Destination: " + trip.country);
  if (trip.purpose) tripLines.push("Purpose: " + trip.purpose);
  if (trip.travelers) tripLines.push("Travelers: " + trip.travelers);
  if (trip.departureDate && trip.returnDate) {
    var days = Math.round((new Date(trip.returnDate) - new Date(trip.departureDate)) / 86400000);
    tripLines.push("Travel dates: " + trip.departureDate + " to " + trip.returnDate + " (" + days + " days)");
  }
  var tripContext = tripLines.length
    ? "\n\nTrip context (use this if the rule asks you to):\n" + tripLines.join("\n")
    : "";

  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    `You are checking a document for a visa application. Today's date is ${today}.\n\n` +
    `Rule to check: ${rule}${tripContext}\n\n` +
    `Respond with ONLY a JSON object, no other text, in exactly this shape:\n` +
    `{"status": "passed" | "needs_review" | "failed", "reason": "explanation", "fix": "what to do next, or empty string if passed"}\n\n` +
    `Use "passed" only if you're confident the document meets the rule — "fix" should be "" in that case.\n` +
    `Use "needs_review" if you're unsure, the image is unclear, or something looks borderline (e.g. funds ` +
    `that seem low but not clearly insufficient) — a human will make the final call, but still tell the ` +
    `customer in "fix" what they could improve or double-check while they wait.\n` +
    `Use "failed" only if the document clearly does not meet the rule (e.g. statement is provably too old, ` +
    `photo is the wrong kind, dates clearly don't work) — "fix" must tell the customer exactly what to ` +
    `upload instead (e.g. "Upload a bank statement dated after 21 April 2026" or "Upload a passport-style ` +
    `photo with a plain background, no sunglasses").\n\n` +
    `Be specific in "reason" — cite the actual date, amount, or detail you saw on the document, never a ` +
    `generic statement like "document doesn't meet requirements".`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GOOGLE_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: prompt }
        ]
      }],
      generationConfig: {
        response_mime_type: "application/json",
        maxOutputTokens: 500
      }
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gemini API returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const candidate = (data.candidates || [])[0];
  const textPart = candidate && candidate.content && (candidate.content.parts || []).find((p) => p.text);
  if (!textPart) {
    // Gemini sometimes returns no candidate if its own safety filters trip —
    // that's a real, distinct failure mode worth surfacing distinctly.
    const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(blockReason ? `Gemini blocked the request: ${blockReason}` : "No text content in Gemini API response");
  }

  let parsed;
  try {
    // Asked for pure JSON via response_mime_type, but strip code-fences
    // defensively in case the model adds them anyway.
    const cleaned = textPart.text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Could not parse model response as JSON: ${textPart.text.slice(0, 200)}`);
  }

  if (!["passed", "needs_review", "failed"].includes(parsed.status)) {
    throw new Error(`Model returned an unexpected status: ${parsed.status}`);
  }
  return {
    status: parsed.status,
    reason: String(parsed.reason || "").slice(0, 500),
    fix: String(parsed.fix || "").slice(0, 500)
  };
}

// GET /api/documents?applicationId=... — list documents + their AI status for an application.
function listForApplication(req, res, applicationId) {
  const user = requireAuth(req, res);
  if (!user) return;

  const application = db.prepare(`SELECT * FROM applications WHERE id = ? AND user_id = ?`).get(applicationId, user.sub);
  if (!application) return sendJson(res, 404, { error: "Application not found for this user." });

  const rows = db.prepare(`SELECT * FROM documents WHERE application_id = ? ORDER BY created_at ASC`).all(applicationId);
  sendJson(res, 200, rows.map((r) => ({
    id: r.id, docType: r.doc_type, status: r.ai_status, reason: r.ai_reason, fix: r.ai_fix,
    reviewedByHuman: !!r.reviewed_by_human, createdAt: r.created_at
  })));
}

// Admin: GET /api/admin/documents/queue — every document across every
// customer that the AI flagged for a human to look at (or that failed
// outright), not yet resolved by a human. This is what admin.html's
// "AI review queue" tab shows.
function adminQueue(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rows = db.prepare(
    `SELECT d.*, a.purpose, a.travelers, c.name as country_name, u.email as user_email
     FROM documents d
     JOIN applications a ON a.id = d.application_id
     JOIN countries c ON c.id = a.country_id
     JOIN users u ON u.id = a.user_id
     WHERE d.reviewed_by_human = 0 AND d.ai_status IN ('needs_review', 'failed')
     ORDER BY d.created_at ASC`
  ).all();

  sendJson(res, 200, rows.map((r) => ({
    id: r.id, docType: r.doc_type, status: r.ai_status, reason: r.ai_reason, fix: r.ai_fix,
    applicationId: r.application_id, userEmail: r.user_email,
    country: r.country_name, purpose: r.purpose, createdAt: r.created_at
  })));
}

// Admin: POST /api/admin/documents/:id/resolve — { action: "approve" | "reject" }
// Marks a flagged document as resolved by a human, one way or the other.
function adminResolve(req, res, body, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const doc = db.prepare(`SELECT id FROM documents WHERE id = ?`).get(id);
  if (!doc) return sendJson(res, 404, { error: "Document not found." });

  const action = body.action;
  if (!["approve", "reject"].includes(action)) {
    return sendJson(res, 400, { error: 'action must be "approve" or "reject".' });
  }
  const newStatus = action === "approve" ? "passed" : "failed";
  db.prepare(`UPDATE documents SET ai_status = ?, reviewed_by_human = 1 WHERE id = ?`).run(newStatus, id);
  sendJson(res, 200, { ok: true, status: newStatus });
}

module.exports = { reviewDocument, listForApplication, adminQueue, adminResolve, DOC_RULES };
