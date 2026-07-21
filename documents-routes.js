// routes/documents.js
// Real AI document review, calling the Anthropic API from the server.
// The API key NEVER goes to the browser — that's the entire point of this
// living on the backend instead of being called directly from the site's JS.

const crypto = require("node:crypto");
const db = require("./db");
const { sendJson, requireAuth } = require("./http-helpers");

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// What the model is asked to check, per document type. Keep this editable —
// it's the actual "business logic" of the review and will need real
// immigration-law input, not just an engineering guess.
const DOC_RULES = {
  "passport-bio-page": "Check: passport is valid at least 6 months beyond a nominal travel date, has at least one blank visa page, the photo page is fully visible and not glare-obscured, and the document doesn't appear to be expired, damaged, or altered.",
  "passport-photo": "Check: a single passport-style photo, plain light background, face fully visible (no sunglasses/hat), roughly passport-photo proportions (not a full-body or group photo).",
  "proof-of-address": "Check: a utility bill or bank statement showing a name and address, dated within the last 3 months.",
  "bank-statement": "Check: a bank statement dated within the last 3 months, showing an account holder name and a closing balance.",
  "travel-insurance": "Check: a travel/medical insurance document showing coverage dates and a minimum medical coverage amount (flag if coverage looks below roughly €30,000 or isn't stated).",
  "invitation-letter": "Check: an invitation or business letter, on what appears to be letterhead, naming the applicant and travel dates."
};

async function reviewDocument(req, res, body) {
  const user = requireAuth(req, res);
  if (!user) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return sendJson(res, 500, {
      error: "AI review isn't configured on this server. Set ANTHROPIC_API_KEY in your .env file."
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

  const application = db.prepare(`SELECT * FROM applications WHERE id = ? AND user_id = ?`).get(applicationId, user.sub);
  if (!application) return sendJson(res, 404, { error: "Application not found for this user." });

  let aiResult;
  try {
    aiResult = await callClaudeVision({ rule, imageBase64, mimeType: mimeType || "image/jpeg" });
  } catch (err) {
    console.error("[documents] AI review call failed:", err.message);
    return sendJson(res, 502, { error: "The AI review service failed. Try again in a moment." });
  }

  const docId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO documents (id, application_id, doc_type, ai_status, ai_reason) VALUES (?, ?, ?, ?, ?)`
  ).run(docId, applicationId, docType, aiResult.status, aiResult.reason);

  sendJson(res, 200, { id: docId, status: aiResult.status, reason: aiResult.reason });
}

// Calls the real Anthropic Messages API with an image and asks for a
// strict-JSON verdict. Uses global fetch (built into Node 18+) — no SDK
// dependency needed for a single endpoint like this.
async function callClaudeVision({ rule, imageBase64, mimeType }) {
  const prompt =
    `You are checking a document for a visa application. ${rule}\n\n` +
    `Respond with ONLY a JSON object, no other text, in exactly this shape:\n` +
    `{"status": "passed" | "needs_review" | "failed", "reason": "one short sentence"}\n\n` +
    `Use "passed" only if you're confident the document meets the rule. Use "needs_review" ` +
    `if you're unsure or the image is unclear (bad photo, cropped, etc.) — a human will check it. ` +
    `Use "failed" only if the document clearly does not meet the rule.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
          { type: "text", text: prompt }
        ]
      }]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic API returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text content in Anthropic API response");

  let parsed;
  try {
    // Model is asked for pure JSON, but strip code-fences defensively in case it adds them.
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Could not parse model response as JSON: ${textBlock.text.slice(0, 200)}`);
  }

  if (!["passed", "needs_review", "failed"].includes(parsed.status)) {
    throw new Error(`Model returned an unexpected status: ${parsed.status}`);
  }
  return { status: parsed.status, reason: String(parsed.reason || "").slice(0, 500) };
}

// GET /api/documents?applicationId=... — list documents + their AI status for an application.
function listForApplication(req, res, applicationId) {
  const user = requireAuth(req, res);
  if (!user) return;

  const application = db.prepare(`SELECT * FROM applications WHERE id = ? AND user_id = ?`).get(applicationId, user.sub);
  if (!application) return sendJson(res, 404, { error: "Application not found for this user." });

  const rows = db.prepare(`SELECT * FROM documents WHERE application_id = ? ORDER BY created_at ASC`).all(applicationId);
  sendJson(res, 200, rows.map((r) => ({
    id: r.id, docType: r.doc_type, status: r.ai_status, reason: r.ai_reason,
    reviewedByHuman: !!r.reviewed_by_human, createdAt: r.created_at
  })));
}

module.exports = { reviewDocument, listForApplication, DOC_RULES };
