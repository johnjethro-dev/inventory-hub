import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const databasePath = resolve(process.env.INVENTORY_DB_PATH || "data/inventory-hub.db");
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('employee','manager','custodian','admin')),
    manager_id INTEGER REFERENCES users(id),
    backup_approver_id INTEGER REFERENCES users(id),
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS consumables (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    unit TEXT NOT NULL DEFAULT 'piece',
    reorder_level REAL NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
    unit_cost REAL NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    supplier TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT 'Main Stockroom',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Equipment',
    serial_number TEXT NOT NULL DEFAULT '',
    condition TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('new','good','fair','damaged')),
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','assigned','loaned','maintenance','retired')),
    purchase_date TEXT,
    purchase_cost REAL NOT NULL DEFAULT 0 CHECK (purchase_cost >= 0),
    supplier TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT 'Main Stockroom',
    assigned_to INTEGER REFERENCES users(id),
    due_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    requester_id INTEGER NOT NULL REFERENCES users(id),
    approver_id INTEGER REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('consumable','asset')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','partially_issued','issued','cancelled')),
    purpose TEXT NOT NULL,
    decision_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    decided_at TEXT,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS request_lines (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    consumable_id INTEGER REFERENCES consumables(id),
    asset_category TEXT,
    quantity_requested REAL NOT NULL DEFAULT 1 CHECK (quantity_requested > 0),
    quantity_issued REAL NOT NULL DEFAULT 0 CHECK (quantity_issued >= 0),
    assignment_type TEXT CHECK (assignment_type IN ('permanent','loan')),
    due_at TEXT
  );
  CREATE TABLE IF NOT EXISTS stock_transactions (
    id INTEGER PRIMARY KEY,
    consumable_id INTEGER NOT NULL REFERENCES consumables(id),
    type TEXT NOT NULL CHECK (type IN ('opening','receive','issue','adjustment','count')),
    quantity_change REAL NOT NULL,
    balance_after REAL NOT NULL CHECK (balance_after >= 0),
    reason TEXT NOT NULL,
    request_id INTEGER REFERENCES requests(id),
    actor_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS asset_history (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    action TEXT NOT NULL,
    from_user_id INTEGER REFERENCES users(id),
    to_user_id INTEGER REFERENCES users(id),
    condition TEXT,
    due_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    request_id INTEGER REFERENCES requests(id),
    actor_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    link TEXT NOT NULL DEFAULT '',
    read_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_outbox (
    id INTEGER PRIMARY KEY,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
  CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requester_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_assets_assigned ON assets(assigned_to);
`);

export function now() {
  return new Date().toISOString();
}

export function hashPassword(password) {
  if (String(password).length < 10) throw new Error("Password must be at least 10 characters.");
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, expectedHex] = stored.split(":");
    if (scheme !== "scrypt") return false;
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function transaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function audit(actorId, action, entityType, entityId, before, after, reason = "") {
  db.prepare(`INSERT INTO audit_log
    (actor_id, action, entity_type, entity_id, before_json, after_json, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(actorId || null, action, entityType, String(entityId), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason, now());
}

export function notify(userId, title, message, link = "") {
  const timestamp = now();
  db.prepare("INSERT INTO notifications (user_id, title, message, link, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, title, message, link, timestamp);
  const user = db.prepare("SELECT email FROM users WHERE id = ? AND active = 1").get(userId);
  if (user) {
    db.prepare("INSERT INTO email_outbox (recipient, subject, body, created_at) VALUES (?, ?, ?, ?)")
      .run(user.email, title, message, timestamp);
  }
}

function seed() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (count) return;
  const timestamp = now();
  transaction(() => {
    const insertUser = db.prepare(`INSERT INTO users
      (name, email, password_hash, role, manager_id, must_change_password, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const admin = insertUser.run("System Administrator", "admin@inventory.local", hashPassword("ChangeMe123!"), "admin", null, 1, timestamp).lastInsertRowid;
    const manager = insertUser.run("Operations Manager", "manager@inventory.local", hashPassword("ChangeMe123!"), "manager", null, 1, timestamp).lastInsertRowid;
    insertUser.run("Inventory Custodian", "custodian@inventory.local", hashPassword("ChangeMe123!"), "custodian", manager, 1, timestamp);
    insertUser.run("Demo Employee", "employee@inventory.local", hashPassword("ChangeMe123!"), "employee", manager, 1, timestamp);
    const insertItem = db.prepare(`INSERT INTO consumables
      (code, name, category, quantity, unit, reorder_level, unit_cost, supplier, location, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertItem.run("PAPER-A4", "A4 Copy Paper", "Office Supplies", 12, "ream", 10, 245, "Office Source", "Shelf A1", timestamp, timestamp);
    insertItem.run("INK-BLK-01", "Black Printer Ink", "Printing", 3, "cartridge", 4, 1150, "PrintWorks", "Cabinet B2", timestamp, timestamp);
    insertItem.run("PEN-BLU", "Blue Ballpoint Pen", "Office Supplies", 60, "piece", 20, 12, "Office Source", "Bin C4", timestamp, timestamp);
    const insertAsset = db.prepare(`INSERT INTO assets
      (code, description, category, serial_number, condition, status, purchase_date, purchase_cost, supplier, location, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertAsset.run("LAP-001", "Lenovo ThinkPad E14", "Laptop", "SN-DEMO-001", "good", "available", "2026-01-15", 48500, "Tech Supply", "IT Cabinet", timestamp, timestamp);
    insertAsset.run("PROJ-001", "Epson Meeting Room Projector", "AV Equipment", "SN-DEMO-002", "fair", "maintenance", "2025-06-10", 32500, "Tech Supply", "Repair Bench", timestamp, timestamp);
    audit(Number(admin), "seed", "system", "initial", null, { users: 4, consumables: 3, assets: 2 }, "Initial demo data");
  });
}

seed();
