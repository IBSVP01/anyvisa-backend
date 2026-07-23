// lib/db.js
// Database layer. Uses Node's built-in `node:sqlite` (stable since Node 22.5+,
// available behind no flag on recent 22.x/23.x/24.x builds). Zero npm dependencies.
//
// If your deployment target runs an older Node, either upgrade to 22.5+
// (recommended — it's an LTS line) or swap this file for `better-sqlite3`,
// which has an almost identical synchronous API.

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "anyvisa.db");

// Git doesn't track empty directories, so the "data" folder this ships with
// locally won't exist on a fresh clone (e.g. on Render). Create it if needed
// rather than requiring an empty folder to somehow survive version control.
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',   -- 'customer' | 'admin'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reset_codes (
    email TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS countries (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    government_fee INTEGER NOT NULL,
    service_fee INTEGER NOT NULL DEFAULT 69,
    is_evisa INTEGER NOT NULL DEFAULT 0,      -- 0/1
    note TEXT DEFAULT '',
    excluded_citizenships TEXT DEFAULT '',    -- comma-separated citizenships we don't serve for this destination (visa-free/visa-waiver — not our service)
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    country_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    travelers INTEGER NOT NULL DEFAULT 1,
    departure_date TEXT,
    return_date TEXT,
    status TEXT NOT NULL DEFAULT 'documents_needed',
    booking_status TEXT NOT NULL DEFAULT 'not_booked',   -- not_booked | booked
    booking_notes TEXT DEFAULT '',
    appointment_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (country_id) REFERENCES countries(id)
  );

  CREATE TABLE IF NOT EXISTS questionnaires (
    application_id TEXT PRIMARY KEY,
    full_name TEXT DEFAULT '',
    date_of_birth TEXT DEFAULT '',
    passport_number TEXT DEFAULT '',
    passport_issue_date TEXT DEFAULT '',
    passport_expiry_date TEXT DEFAULT '',
    nationality TEXT DEFAULT '',
    address TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    occupation TEXT DEFAULT '',
    employer TEXT DEFAULT '',
    previous_refusal TEXT DEFAULT '',
    previous_refusal_details TEXT DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (application_id) REFERENCES applications(id)
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    file_path TEXT,
    ai_status TEXT NOT NULL DEFAULT 'pending',   -- pending | passed | needs_review | failed
    ai_reason TEXT DEFAULT '',
    ai_fix TEXT DEFAULT '',
    reviewed_by_human INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (application_id) REFERENCES applications(id)
  );

  CREATE TABLE IF NOT EXISTS country_documents (
    id TEXT PRIMARY KEY,
    country_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,      -- slug, e.g. "bank-statement"
    doc_name TEXT NOT NULL,      -- shown to the customer, e.g. "Bank statement"
    doc_sub TEXT DEFAULT '',     -- short description under the name
    ai_rule TEXT NOT NULL,       -- what the AI checks this document against
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (country_id) REFERENCES countries(id)
  );
`);

// ---- migration: add `name` to any pre-existing users table that predates it ----
const userCols = db.prepare(`PRAGMA table_info(users)`).all();
if (!userCols.some((c) => c.name === "name")) {
  db.exec(`ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
}

// ---- migration: add travel dates to any pre-existing applications table ----
const appCols = db.prepare(`PRAGMA table_info(applications)`).all();
if (!appCols.some((c) => c.name === "departure_date")) {
  db.exec(`ALTER TABLE applications ADD COLUMN departure_date TEXT`);
}
if (!appCols.some((c) => c.name === "return_date")) {
  db.exec(`ALTER TABLE applications ADD COLUMN return_date TEXT`);
}

// ---- migration: add ai_fix to any pre-existing documents table ----
const docCols = db.prepare(`PRAGMA table_info(documents)`).all();
if (!docCols.some((c) => c.name === "ai_fix")) {
  db.exec(`ALTER TABLE documents ADD COLUMN ai_fix TEXT DEFAULT ''`);
}

// ---- migration: add excluded_citizenships to any pre-existing countries table ----
const countryCols = db.prepare(`PRAGMA table_info(countries)`).all();
if (!countryCols.some((c) => c.name === "excluded_citizenships")) {
  db.exec(`ALTER TABLE countries ADD COLUMN excluded_citizenships TEXT DEFAULT ''`);
}

// ---- migration: create country_documents table if this DB predates it ----
db.exec(`
  CREATE TABLE IF NOT EXISTS country_documents (
    id TEXT PRIMARY KEY,
    country_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    doc_name TEXT NOT NULL,
    doc_sub TEXT DEFAULT '',
    ai_rule TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (country_id) REFERENCES countries(id)
  );
`);

// ---- migration: add manual-booking fields to any pre-existing applications table ----
const appCols2 = db.prepare(`PRAGMA table_info(applications)`).all();
if (!appCols2.some((c) => c.name === "booking_status")) {
  db.exec(`ALTER TABLE applications ADD COLUMN booking_status TEXT NOT NULL DEFAULT 'not_booked'`);
}
if (!appCols2.some((c) => c.name === "booking_notes")) {
  db.exec(`ALTER TABLE applications ADD COLUMN booking_notes TEXT DEFAULT ''`);
}
if (!appCols2.some((c) => c.name === "appointment_at")) {
  db.exec(`ALTER TABLE applications ADD COLUMN appointment_at TEXT`);
}

// ---- migration: create questionnaires table if this DB predates it ----
db.exec(`
  CREATE TABLE IF NOT EXISTS questionnaires (
    application_id TEXT PRIMARY KEY,
    full_name TEXT DEFAULT '',
    date_of_birth TEXT DEFAULT '',
    passport_number TEXT DEFAULT '',
    passport_issue_date TEXT DEFAULT '',
    passport_expiry_date TEXT DEFAULT '',
    nationality TEXT DEFAULT '',
    address TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    occupation TEXT DEFAULT '',
    employer TEXT DEFAULT '',
    previous_refusal TEXT DEFAULT '',
    previous_refusal_details TEXT DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (application_id) REFERENCES applications(id)
  );
`);

// ---- seed default countries (matches the current front-end demo data) ----
const countrySeed = [
  // ---- e-visa / non-Schengen destinations ----
  ["usa",          "USA",             340, 69, 0, "Interview required at the embassy; we prepare your DS-160 and book the appointment. Fee includes the 2026 Visa Integrity Fee."],
  ["saudi-arabia", "Saudi Arabia",    93,  69, 1, "Tourist e-visa filed fully online. Business visits may need the consulate instead — we'll confirm which applies."],
  ["nigeria",      "Nigeria",         105, 69, 1, "Visa required for all nationalities we serve. Filed online where the applicant is eligible."],
  ["angola",       "Angola",          80,  69, 1, "Some nationalities are visa-exempt for short tourist stays — we confirm this for you before filing. Business visits always require a visa."],
  ["russia",       "Russia",          91,  69, 1, "E-visa applications only through AnyVisa — no embassy/consulate service offered for Russia."],

  // ---- Schengen area (27 states) — standardized EU visa fee and document set ----
  ["austria",       "Austria",       69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["belgium",       "Belgium",       69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["croatia",       "Croatia",       69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["czech-republic","Czech Republic",69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["denmark",       "Denmark",       69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["estonia",       "Estonia",       69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["finland",       "Finland",       69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["france",        "France",        69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["germany",       "Germany",       69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["greece",        "Greece",        69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["hungary",       "Hungary",       69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["iceland",       "Iceland",       69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["italy",         "Italy",         69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["latvia",        "Latvia",        69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["liechtenstein", "Liechtenstein", 69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["lithuania",     "Lithuania",     69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["luxembourg",    "Luxembourg",    69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["malta",         "Malta",         69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["netherlands",   "Netherlands",   69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["norway",        "Norway",        69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["poland",        "Poland",        69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["portugal",      "Portugal",      69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["slovakia",      "Slovakia",      69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["slovenia",      "Slovenia",      69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["spain",         "Spain",         69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["sweden",        "Sweden",        69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."],
  ["switzerland",   "Switzerland",   69, 69, 0, "Standard Schengen visa — apply to whichever member state is your main destination."]
];
const seedStmt = db.prepare(
  `INSERT OR IGNORE INTO countries (id, name, government_fee, service_fee, is_evisa, note) VALUES (?, ?, ?, ?, ?, ?)`
);
for (const row of countrySeed) seedStmt.run(...row);

// Remove any destinations not in the approved list above (e.g. old test
// data seeded before this list was finalized — China/India/Egypt/Turkey/
// Vietnam/Kazakhstan were never real destinations we file to).
const approvedIds = countrySeed.map((r) => r[0]);
const placeholders = approvedIds.map(() => "?").join(",");
try {
  db.prepare(`DELETE FROM countries WHERE id NOT IN (${placeholders})`).run(...approvedIds);
} catch (err) {
  console.warn("[db] Could not remove old test-data countries (likely referenced by existing test applications):", err.message);
}

// ---- seed a default admin user (email/password from env, or a dev default) ----
// IMPORTANT: change ADMIN_EMAIL / ADMIN_PASSWORD via environment variables in
// production. The fallback below is for local development only.
const { hashPassword } = require("./auth-core");
const adminEmail = process.env.ADMIN_EMAIL || "admin@anyvisa.co.uk";
const existingAdmin = db.prepare(`SELECT id FROM users WHERE email = ?`).get(adminEmail);
if (!existingAdmin) {
  const adminPassword = process.env.ADMIN_PASSWORD || "changeme-immediately";
  const { hash, salt } = hashPassword(adminPassword);
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, role) VALUES (?, ?, 'Admin', ?, ?, 'admin')`
  ).run(crypto.randomUUID(), adminEmail, hash, salt);
  console.log(`[db] Seeded admin user: ${adminEmail} (change ADMIN_PASSWORD env var in production!)`);
}

// ---- seed document requirements per country (researched, editable via admin later) ----
// Sources checked: EU Visa Code / Schengen consulate checklists, US Dept of
// State DS-160 requirements, Saudi e-visa portal requirements. These are a
// solid starting point, not a substitute for a compliance review — visa
// rules change and vary by exact case. Edit freely in the admin panel.

const SCHENGEN_DOCS = [
  ["passport-bio-page", "Passport — bio page", "Valid 3+ months beyond your departure date from the Schengen area, 2 blank pages",
    "Check: passport valid at least 3 months beyond the trip's departure/return date, at least 2 blank visa pages, issued within the last 10 years, not damaged or altered."],
  ["passport-photo", "Passport photo", "35×45mm, plain light background, taken within the last 6 months",
    "Check: a single passport-style photo, plain light background, face fully visible (no sunglasses/hat), roughly 35x45mm proportions, not a full-body or group photo."],
  ["flight-itinerary", "Flight itinerary", "Round-trip reservation showing dates and flight numbers — doesn't need to be a paid ticket",
    "Check: a flight reservation or itinerary showing round-trip dates and flight numbers matching the trip dates given below, in the applicant's name. A held reservation is fine; a fully paid ticket is not required."],
  ["accommodation-proof", "Proof of accommodation", "Hotel booking or invitation letter covering every night of the trip",
    "Check: a hotel booking, Airbnb reservation, or host invitation letter that covers the full length of the trip given below, with dates matching the travel dates."],
  ["bank-statement", "Bank statement", "Last 3-6 months, showing regular income and sufficient balance",
    "Check TWO things: (1) the statement's date — it must be within the last 3 months of today's date, state clearly by how many months it's outside that window if not; (2) if trip dates are provided below, whether the closing balance looks reasonable for that trip length and destination (a rough rule of thumb: at least ~£50-100/day per traveler) — if it looks low, say so as something for a human to judge, don't hard-fail on this alone."],
  ["travel-insurance", "Travel insurance", "Minimum €30,000 medical coverage, valid for the whole Schengen area and trip dates",
    "Check: a travel/medical insurance document showing coverage dates spanning the full trip, valid across the Schengen area, with medical coverage of at least €30,000. Flag if coverage looks lower or isn't stated."]
];

const USA_DOCS = [
  ["passport-bio-page", "Passport — bio page", "Valid 6+ months beyond your intended stay in the US",
    "Check: passport valid at least 6 months beyond the trip's return date, at least 2 blank visa pages, not damaged or altered."],
  ["ds160-confirmation", "DS-160 confirmation page", "Printed confirmation page with barcode from the online DS-160 form",
    "Check: this is a genuine DS-160 nonimmigrant visa application confirmation page, showing a barcode and confirmation number. Flag if it looks incomplete or isn't a DS-160 page at all."],
  ["visa-fee-receipt", "Visa fee payment receipt", "Proof of payment for the MRV fee and the 2026 Visa Integrity Fee",
    "Check: a payment receipt or confirmation showing the US visa application (MRV) fee was paid. Flag if it's unclear this is a genuine State Department fee receipt."],
  ["passport-photo", "Photo", "2x2 inch (51x51mm), white background, taken within the last 6 months",
    "Check: a single US visa photo, plain white background, face fully visible, roughly 2x2 inch square proportions (not a rectangular passport-style photo)."],
  ["proof-of-ties", "Proof of ties to home country", "Employment letter, property documents, or family ties showing intent to return",
    "Check: a document showing the applicant's ties to their home country — an employment letter confirming their job and approved leave, property ownership documents, or similar. This is used to judge intent to return, so needs_review rather than a hard fail is appropriate for anything borderline."]
];

const SAUDI_DOCS = [
  ["passport-bio-page", "Passport — bio page", "Valid 6+ months beyond your intended stay, 2 blank pages",
    "Check: passport valid at least 6 months beyond the trip's return date, at least 2 blank visa pages, not damaged or altered."],
  ["passport-photo", "Passport photo", "Recent (within 6 months), 35×45mm, plain background",
    "Check: a single passport-style photo, plain background, face fully visible, roughly 35x45mm proportions."],
  ["flight-itinerary", "Flight itinerary", "Confirmed round-trip booking or itinerary",
    "Check: a flight reservation or itinerary showing round-trip dates and flight numbers matching the trip dates given below."],
  ["accommodation-proof", "Proof of accommodation", "Hotel booking or invitation letter",
    "Check: a hotel booking, Airbnb reservation, or host invitation letter covering the length of the trip given below."],
  ["bank-statement", "Bank statement", "Recent statement showing sufficient funds for the trip",
    "Check TWO things: (1) the statement's date — within the last 3 months of today's date; (2) if trip dates are provided below, whether the closing balance looks reasonable for that trip length (rough rule of thumb: at least ~£50-100/day per traveler) — flag low amounts for human review rather than hard-failing."],
  ["travel-insurance", "Travel health insurance", "Mandatory for all visitors to Saudi Arabia",
    "Check: a travel/medical insurance document showing coverage dates spanning the full trip. Flag if coverage amount isn't stated or looks low."]
];

const NIGERIA_DOCS = [
  ["passport-bio-page", "Passport — bio page", "Valid 6+ months beyond your intended stay",
    "Check: passport valid at least 6 months beyond the trip's return date, at least 2 blank visa pages, not damaged or altered."],
  ["passport-photo", "Passport photo", "Recent, plain background",
    "Check: a single passport-style photo, plain background, face fully visible."],
  ["flight-itinerary", "Flight itinerary", "Proof of onward/return travel",
    "Check: a flight reservation or itinerary showing dates matching the trip below, including onward/return travel."],
  ["accommodation-proof", "Proof of accommodation", "Hotel booking or invitation letter",
    "Check: a hotel booking or host invitation letter covering the trip dates given below."],
  ["bank-statement", "Bank statement", "Recent statement showing sufficient funds",
    "Check TWO things: (1) the statement's date — within the last 3 months; (2) if trip dates are provided, whether the balance looks reasonable for the trip length — flag low amounts for human review rather than hard-failing."]
];

const ANGOLA_DOCS = [
  ["passport-bio-page", "Passport — bio page", "Valid 6+ months beyond your intended stay, at least 1 blank page",
    "Check: passport valid at least 6 months beyond the trip's return date, at least 1 blank visa page, not damaged or altered."],
  ["passport-photo", "Passport photo", "Recent, plain background",
    "Check: a single passport-style photo, plain background, face fully visible."],
  ["flight-itinerary", "Flight itinerary", "Round-trip reservation with dates and flight numbers",
    "Check: a flight reservation or itinerary showing round-trip dates matching the trip below."],
  ["accommodation-proof", "Proof of accommodation", "Hotel booking or host details",
    "Check: a hotel booking or host invitation letter covering the trip dates given below."],
  ["bank-statement", "Bank statement", "Recent statement showing sufficient funds",
    "Check TWO things: (1) the statement's date — within the last 3 months; (2) if trip dates are provided, whether the balance looks reasonable for the trip length — flag low amounts for human review rather than hard-failing."]
];

const RUSSIA_DOCS = [
  ["passport-bio-page", "Passport — bio page", "Valid 6+ months beyond your intended stay",
    "Check: passport valid at least 6 months beyond the trip's return date, not damaged or altered — Russia's e-visa has lighter passport-page requirements than a full consulate visa."],
  ["passport-photo", "Passport photo", "Recent, plain light background",
    "Check: a single passport-style photo, plain light background, face fully visible."],
  ["flight-itinerary", "Flight itinerary", "Travel dates matching the e-visa application",
    "Check: a flight reservation or itinerary with dates matching the trip given below."],
  ["accommodation-proof", "Proof of accommodation", "Hotel booking or invitation for the e-visa application",
    "Check: a hotel booking or invitation letter with dates matching the trip given below."]
];

const schengenIds = [
  "austria","belgium","croatia","czech-republic","denmark","estonia","finland","france","germany",
  "greece","hungary","iceland","italy","latvia","liechtenstein","lithuania","luxembourg","malta",
  "netherlands","norway","poland","portugal","slovakia","slovenia","spain","sweden","switzerland"
];

const docInsert = db.prepare(
  `INSERT OR IGNORE INTO country_documents (id, country_id, doc_type, doc_name, doc_sub, ai_rule, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
function seedDocsForCountry(countryId, docs) {
  docs.forEach((d, i) => {
    docInsert.run(`${countryId}-${d[0]}`, countryId, d[0], d[1], d[2], d[3], i);
  });
}
schengenIds.forEach((id) => seedDocsForCountry(id, SCHENGEN_DOCS));
seedDocsForCountry("usa", USA_DOCS);
seedDocsForCountry("saudi-arabia", SAUDI_DOCS);
seedDocsForCountry("nigeria", NIGERIA_DOCS);
seedDocsForCountry("angola", ANGOLA_DOCS);
seedDocsForCountry("russia", RUSSIA_DOCS);

// ---- excluded citizenships per destination ----
// These are combinations where no visa application exists for us to file —
// either genuine freedom of movement (Schengen citizens inside Schengen) or
// an established visa-waiver program (US Visa Waiver Program / UK-Schengen
// mutual short-stay exemption). We're not telling the customer "no visa
// needed" — we simply don't offer that citizenship+destination pairing.
const schengenNames = [
  "Austria","Belgium","Croatia","Czech Republic","Denmark","Estonia","Finland","France","Germany",
  "Greece","Hungary","Iceland","Italy","Latvia","Liechtenstein","Lithuania","Luxembourg","Malta",
  "Netherlands","Norway","Poland","Portugal","Slovakia","Slovenia","Spain","Sweden","Switzerland"
];
const setExclusions = db.prepare(`UPDATE countries SET excluded_citizenships = ? WHERE id = ?`);

// Every Schengen destination excludes: all Schengen citizenships (freedom of
// movement) plus USA and United Kingdom (short-stay exempt / ETIAS territory,
// not a visa we file).
schengenIds.forEach((destId) => {
  const excluded = schengenNames.concat(["USA", "United Kingdom"]).join(",");
  setExclusions.run(excluded, destId);
});

// USA excludes all Schengen citizenships plus United Kingdom — all eligible
// for ESTA under the US Visa Waiver Program, not a visa application.
setExclusions.run(schengenNames.concat(["United Kingdom"]).join(","), "usa");

module.exports = db;
