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
  ["russia",       "Russia",        91,  69, 0, "Invitation arranged automatically if you don't have one."],
  ["china",        "China",         151, 69, 0, "Biometrics slot pre-booked automatically."],
  ["india",        "India",         127, 69, 1, "Tourist e-visa is filed fully online."],
  ["usa",          "USA",           185, 69, 0, "Interview required; we prepare your DS-160 and book it."],
  ["saudi-arabia", "Saudi Arabia",  118, 69, 1, "Tourist e-visa filed online; business via consulate."],
  ["nigeria",      "Nigeria",       105, 69, 1, "Visa-on-arrival approval processed fully online."],
  ["egypt",        "Egypt",         25,  69, 1, "E-visa filed fully online — typical decision in days."],
  ["turkey",       "Turkey",        43,  69, 1, "E-visa for eligible nationalities."],
  ["vietnam",      "Vietnam",       21,  69, 1, "E-visa filed fully online."],
  ["kazakhstan",   "Kazakhstan",    0,   69, 0, "Visa-free up to 30 days for UK nationals."]
];
const seedStmt = db.prepare(
  `INSERT OR IGNORE INTO countries (id, name, government_fee, service_fee, is_evisa, note) VALUES (?, ?, ?, ?, ?, ?)`
);
for (const row of countrySeed) seedStmt.run(...row);

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

module.exports = db;
