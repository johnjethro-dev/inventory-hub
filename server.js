import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db, now, hashPassword, verifyPassword, transaction, audit, notify } from "./db.js";
import { can, calculateIssue, normalizeCode, parseCsv, requirePositiveNumber, toCsv, validateRequestTransition } from "./core.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(root, "public");
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || "127.0.0.1";
const sessionMinutes = Number(process.env.SESSION_MINUTES || 30);
const loginAttempts = new Map();
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

function errorResponse(response, status, message, details) {
  json(response, status, { error: message, ...(details ? { details } : {}) });
}

async function readBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  if ((request.headers["content-type"] || "").includes("text/csv")) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function currentUser(request) {
  const token = cookies(request).inventory_session;
  if (!token) return null;
  const timestamp = now();
  const session = db.prepare(`SELECT s.token_hash, s.user_id, s.last_seen_at, s.expires_at,
      u.name, u.email, u.role, u.manager_id, u.backup_approver_id, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(tokenHash(token), timestamp);
  if (!session) return null;
  const inactiveAt = Date.parse(session.last_seen_at) + sessionMinutes * 60_000;
  if (inactiveAt < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
    return null;
  }
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(timestamp, session.token_hash);
  return {
    id: session.user_id,
    name: session.name,
    email: session.email,
    role: session.role,
    managerId: session.manager_id,
    backupApproverId: session.backup_approver_id,
    mustChangePassword: Boolean(session.must_change_password),
  };
}

function requireUser(request, response, action) {
  const user = currentUser(request);
  if (!user) {
    errorResponse(response, 401, "Please sign in to continue.");
    return null;
  }
  if (action && !can(user, action)) {
    errorResponse(response, 403, "You do not have permission to perform this action.");
    return null;
  }
  return user;
}

function requireMutationHeader(request, response) {
  if (request.headers["x-requested-with"] !== "inventory-hub") {
    errorResponse(response, 403, "The request could not be verified.");
    return false;
  }
  return true;
}

function publicUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword } : null;
}

function rows(statement, ...parameters) {
  return db.prepare(statement).all(...parameters);
}

function getDashboard(user) {
  const isEmployee = user.role === "employee";
  const requestWhere = isEmployee ? "WHERE r.requester_id = ?" : user.role === "manager" ? "WHERE r.requester_id IN (SELECT id FROM users WHERE manager_id = ? OR backup_approver_id = ?) OR r.requester_id = ?" : "";
  const requestParameters = isEmployee ? [user.id] : user.role === "manager" ? [user.id, user.id, user.id] : [];
  const requests = rows(`SELECT r.*, u.name AS requester_name, a.name AS approver_name,
      rl.id AS line_id, rl.consumable_id, rl.asset_category, rl.quantity_requested, rl.quantity_issued, rl.assignment_type, rl.due_at,
      c.code AS item_code, c.name AS item_name
    FROM requests r
    JOIN users u ON u.id = r.requester_id
    LEFT JOIN users a ON a.id = r.approver_id
    JOIN request_lines rl ON rl.request_id = r.id
    LEFT JOIN consumables c ON c.id = rl.consumable_id
    ${requestWhere}
    ORDER BY r.created_at DESC LIMIT 100`, ...requestParameters);
  const assets = user.role === "employee" || user.role === "manager"
    ? rows(`SELECT a.*, u.name AS assigned_name FROM assets a LEFT JOIN users u ON u.id = a.assigned_to
        WHERE a.assigned_to = ? OR a.status IN ('available','maintenance') ORDER BY a.code`, user.id)
    : rows("SELECT a.*, u.name AS assigned_name FROM assets a LEFT JOIN users u ON u.id = a.assigned_to ORDER BY a.code");
  const consumables = rows("SELECT * FROM consumables WHERE active = 1 ORDER BY name");
  const notifications = rows("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 25", user.id);
  const counts = {
    pending: requests.filter((item) => item.status === "pending").length,
    lowStock: consumables.filter((item) => item.quantity <= item.reorder_level).length,
    overdue: assets.filter((item) => item.status === "loaned" && item.due_at && item.due_at < now()).length,
    maintenance: assets.filter((item) => item.status === "maintenance").length,
  };
  const recentActivity = user.role === "admin" || user.role === "custodian"
    ? rows(`SELECT al.*, u.name AS actor_name FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id
        ORDER BY al.created_at DESC LIMIT 20`)
    : [];
  return { user: publicUser(user), counts, requests, assets, consumables, notifications, recentActivity };
}

function approverFor(user) {
  if (user.managerId) return user.managerId;
  const fallback = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
  if (!fallback) throw new Error("No approver is configured for this employee.");
  return fallback.id;
}

function canApprove(user, requestRecord) {
  if (user.role === "admin") return true;
  if (user.role !== "manager" || requestRecord.approver_id !== user.id) return false;
  const requester = db.prepare("SELECT manager_id, backup_approver_id FROM users WHERE id = ?").get(requestRecord.requester_id);
  return requester && (requester.manager_id === user.id || requester.backup_approver_id === user.id);
}

function requestDetail(id) {
  return db.prepare(`SELECT r.*, rl.id AS line_id, rl.consumable_id, rl.asset_category, rl.quantity_requested,
      rl.quantity_issued, rl.assignment_type, rl.due_at, c.name AS item_name
    FROM requests r JOIN request_lines rl ON rl.request_id = r.id
    LEFT JOIN consumables c ON c.id = rl.consumable_id WHERE r.id = ?`).get(id);
}

async function login(request, response) {
  const ip = request.socket.remoteAddress || "unknown";
  const record = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60_000 };
  if (record.resetAt < Date.now()) Object.assign(record, { count: 0, resetAt: Date.now() + 15 * 60_000 });
  if (record.count >= 8) return errorResponse(response, 429, "Too many sign-in attempts. Try again later.");
  const body = await readBody(request);
  const user = db.prepare("SELECT * FROM users WHERE email = ? AND active = 1").get(String(body.email || "").trim());
  if (!user || !verifyPassword(String(body.password || ""), user.password_hash)) {
    record.count += 1;
    loginAttempts.set(ip, record);
    return errorResponse(response, 401, "Email or password is incorrect.");
  }
  loginAttempts.delete(ip);
  const token = randomBytes(32).toString("base64url");
  const timestamp = now();
  const expires = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, last_seen_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash(token), user.id, timestamp, expires);
  audit(user.id, "login", "session", tokenHash(token).slice(0, 12), null, { ip }, "Successful sign-in");
  const secure = Boolean(process.env.TLS_CERT_PATH);
  return json(response, 200, { user: { id: user.id, name: user.name, email: user.email, role: user.role, mustChangePassword: Boolean(user.must_change_password) } }, {
    "set-cookie": `inventory_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`,
  });
}

async function createRequest(request, response, user) {
  const body = await readBody(request);
  if (!['consumable', 'asset'].includes(body.type)) throw new Error("Request type must be consumable or asset.");
  const purpose = String(body.purpose || "").trim();
  if (purpose.length < 3) throw new Error("Please provide a short purpose for this request.");
  const approverId = approverFor(user);
  const createdAt = now();
  const requestId = transaction(() => {
    const result = db.prepare(`INSERT INTO requests (requester_id, approver_id, type, purpose, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(user.id, approverId, body.type, purpose, createdAt);
    const id = Number(result.lastInsertRowid);
    if (body.type === "consumable") {
      const item = db.prepare("SELECT id FROM consumables WHERE id = ? AND active = 1").get(Number(body.consumableId));
      if (!item) throw new Error("Select a valid consumable item.");
      db.prepare(`INSERT INTO request_lines (request_id, consumable_id, quantity_requested)
        VALUES (?, ?, ?)`).run(id, item.id, requirePositiveNumber(body.quantity, "Quantity"));
    } else {
      const category = String(body.assetCategory || "").trim();
      if (!category) throw new Error("Select or enter an asset category.");
      const assignmentType = body.assignmentType === "loan" ? "loan" : "permanent";
      if (assignmentType === "loan" && !body.dueAt) throw new Error("Temporary loans require a due date.");
      db.prepare(`INSERT INTO request_lines (request_id, asset_category, assignment_type, due_at)
        VALUES (?, ?, ?, ?)`).run(id, category, assignmentType, body.dueAt || null);
    }
    audit(user.id, "create", "request", id, null, { type: body.type, purpose }, purpose);
    return id;
  });
  notify(approverId, "Inventory request awaiting approval", `${user.name} submitted a ${body.type} request.`, `#requests/${requestId}`);
  return json(response, 201, { id: requestId });
}

async function decideRequest(request, response, user, id, decision) {
  const body = await readBody(request);
  const record = requestDetail(id);
  if (!record) return errorResponse(response, 404, "Request not found.");
  if (!canApprove(user, record)) return errorResponse(response, 403, "Only the assigned manager or administrator may decide this request.");
  validateRequestTransition(record.status, decision);
  const timestamp = now();
  db.prepare("UPDATE requests SET status = ?, decision_note = ?, decided_at = ? WHERE id = ?")
    .run(decision, String(body.note || "").trim(), timestamp, id);
  audit(user.id, decision, "request", id, { status: record.status }, { status: decision }, body.note || "");
  notify(record.requester_id, `Request ${decision}`, `Your request #${id} was ${decision}.`, `#requests/${id}`);
  if (decision === "approved") {
    for (const custodian of rows("SELECT id FROM users WHERE role IN ('custodian','admin') AND active = 1")) {
      notify(custodian.id, "Approved request ready to issue", `Request #${id} is ready for fulfillment.`, `#requests/${id}`);
    }
  }
  return json(response, 200, { status: decision });
}

async function cancelRequest(request, response, user, id) {
  const record = requestDetail(id);
  if (!record) return errorResponse(response, 404, "Request not found.");
  if (record.requester_id !== user.id && user.role !== "admin") return errorResponse(response, 403, "Only the requester or administrator may cancel this request.");
  validateRequestTransition(record.status, "cancelled");
  db.prepare("UPDATE requests SET status = 'cancelled', completed_at = ? WHERE id = ?").run(now(), id);
  audit(user.id, "cancel", "request", id, { status: record.status }, { status: "cancelled" }, "Cancelled by requester");
  return json(response, 200, { status: "cancelled" });
}

async function issueRequest(request, response, user, id) {
  const body = await readBody(request);
  const record = requestDetail(id);
  if (!record) return errorResponse(response, 404, "Request not found.");
  if (!['approved', 'partially_issued'].includes(record.status)) throw new Error("Only approved requests can be issued.");
  if (record.type === "consumable") {
    const result = transaction(() => {
      const item = db.prepare("SELECT * FROM consumables WHERE id = ?").get(record.consumable_id);
      const issue = calculateIssue(record.quantity_requested, record.quantity_issued, body.quantity, item.quantity);
      db.prepare("UPDATE consumables SET quantity = ?, updated_at = ? WHERE id = ?").run(issue.remainingStock, now(), item.id);
      db.prepare("UPDATE request_lines SET quantity_issued = ? WHERE id = ?").run(issue.totalIssued, record.line_id);
      db.prepare("UPDATE requests SET status = ?, completed_at = ? WHERE id = ?")
        .run(issue.status, issue.status === "issued" ? now() : null, id);
      db.prepare(`INSERT INTO stock_transactions
        (consumable_id, type, quantity_change, balance_after, reason, request_id, actor_id, created_at)
        VALUES (?, 'issue', ?, ?, ?, ?, ?, ?)`)
        .run(item.id, -Number(body.quantity), issue.remainingStock, `Issued for request #${id}`, id, user.id, now());
      audit(user.id, "issue", "consumable", item.id, { quantity: item.quantity }, { quantity: issue.remainingStock }, `Request #${id}`);
      return issue;
    });
    notify(record.requester_id, result.status === "issued" ? "Request fulfilled" : "Request partially issued", `Request #${id} has been ${result.status.replace("_", " ")}.`, `#requests/${id}`);
    return json(response, 200, result);
  }
  const asset = db.prepare("SELECT * FROM assets WHERE id = ?").get(Number(body.assetId));
  if (!asset || asset.status !== "available") throw new Error("Select an available asset.");
  if (asset.category.toLowerCase() !== String(record.asset_category).toLowerCase() && !body.confirmCategoryMismatch) {
    throw new Error("The selected asset category does not match the request.");
  }
  const status = record.assignment_type === "loan" ? "loaned" : "assigned";
  transaction(() => {
    db.prepare("UPDATE assets SET status = ?, assigned_to = ?, due_at = ?, updated_at = ? WHERE id = ?")
      .run(status, record.requester_id, record.assignment_type === "loan" ? record.due_at : null, now(), asset.id);
    db.prepare("UPDATE request_lines SET quantity_issued = 1 WHERE id = ?").run(record.line_id);
    db.prepare("UPDATE requests SET status = 'issued', completed_at = ? WHERE id = ?").run(now(), id);
    db.prepare(`INSERT INTO asset_history
      (asset_id, action, to_user_id, condition, due_at, notes, request_id, actor_id, created_at)
      VALUES (?, 'assign', ?, ?, ?, ?, ?, ?, ?)`)
      .run(asset.id, record.requester_id, asset.condition, record.due_at, record.assignment_type, id, user.id, now());
    audit(user.id, "assign", "asset", asset.id, { status: asset.status }, { status, assignedTo: record.requester_id, dueAt: record.due_at }, `Request #${id}`);
  });
  notify(record.requester_id, "Asset ready", `${asset.code} was assigned to you.`, `#assets/${asset.id}`);
  return json(response, 200, { status: "issued", assetId: asset.id });
}

async function stockChange(request, response, user, action) {
  const body = await readBody(request);
  const item = db.prepare("SELECT * FROM consumables WHERE id = ? AND active = 1").get(Number(body.consumableId));
  if (!item) return errorResponse(response, 404, "Consumable not found.");
  const reason = String(body.reason || "").trim();
  if (reason.length < 3) throw new Error("A reason is required.");
  let change;
  let balance;
  if (action === "receive") {
    change = requirePositiveNumber(body.quantity, "Quantity");
    balance = item.quantity + change;
  } else {
    balance = Number(body.newQuantity);
    if (!Number.isFinite(balance) || balance < 0) throw new Error("New quantity must be zero or greater.");
    change = balance - item.quantity;
  }
  transaction(() => {
    db.prepare("UPDATE consumables SET quantity = ?, updated_at = ? WHERE id = ?").run(balance, now(), item.id);
    db.prepare(`INSERT INTO stock_transactions
      (consumable_id, type, quantity_change, balance_after, reason, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, action === "receive" ? "receive" : "adjustment", change, balance, reason, user.id, now());
    audit(user.id, action, "consumable", item.id, { quantity: item.quantity }, { quantity: balance }, reason);
  });
  if (balance <= item.reorder_level) {
    for (const recipient of rows("SELECT id FROM users WHERE role IN ('custodian','admin') AND active = 1")) {
      notify(recipient.id, "Low stock warning", `${item.name} has ${balance} ${item.unit} remaining.`, "#inventory");
    }
  }
  return json(response, 200, { quantity: balance });
}

async function returnAsset(request, response, user, id) {
  const body = await readBody(request);
  const asset = db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
  if (!asset) return errorResponse(response, 404, "Asset not found.");
  if (!['assigned', 'loaned'].includes(asset.status)) throw new Error("This asset is not currently assigned.");
  const condition = ['new', 'good', 'fair', 'damaged'].includes(body.condition) ? body.condition : asset.condition;
  const nextStatus = condition === "damaged" || body.sendToMaintenance ? "maintenance" : "available";
  transaction(() => {
    db.prepare("UPDATE assets SET condition = ?, status = ?, assigned_to = NULL, due_at = NULL, updated_at = ? WHERE id = ?")
      .run(condition, nextStatus, now(), id);
    db.prepare(`INSERT INTO asset_history
      (asset_id, action, from_user_id, condition, notes, actor_id, created_at)
      VALUES (?, 'return', ?, ?, ?, ?, ?)`)
      .run(id, asset.assigned_to, condition, String(body.notes || ""), user.id, now());
    audit(user.id, "return", "asset", id, asset, { status: nextStatus, condition, assigned_to: null }, body.notes || "");
  });
  if (asset.assigned_to) notify(asset.assigned_to, "Asset return recorded", `${asset.code} was returned in ${condition} condition.`, `#assets/${id}`);
  return json(response, 200, { status: nextStatus, condition });
}

async function updateAssetStatus(request, response, user, id) {
  const body = await readBody(request);
  const asset = db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
  if (!asset) return errorResponse(response, 404, "Asset not found.");
  if (!['available', 'maintenance', 'retired'].includes(body.status)) throw new Error("Invalid asset status.");
  if (asset.assigned_to) throw new Error("Return the asset before changing its availability status.");
  db.prepare("UPDATE assets SET status = ?, updated_at = ? WHERE id = ?").run(body.status, now(), id);
  db.prepare(`INSERT INTO asset_history (asset_id, action, condition, notes, actor_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, body.status, asset.condition, String(body.notes || ""), user.id, now());
  audit(user.id, body.status, "asset", id, { status: asset.status }, { status: body.status }, body.notes || "");
  return json(response, 200, { status: body.status });
}

async function createConsumable(request, response, user) {
  const body = await readBody(request);
  const code = normalizeCode(body.code);
  const name = String(body.name || "").trim();
  if (!code || !name) throw new Error("Code and name are required.");
  const timestamp = now();
  const id = transaction(() => {
    const result = db.prepare(`INSERT INTO consumables
      (code, name, category, quantity, unit, reorder_level, unit_cost, supplier, location, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, name, String(body.category || "General"), Math.max(0, Number(body.quantity) || 0), String(body.unit || "piece"), Math.max(0, Number(body.reorderLevel) || 0), Math.max(0, Number(body.unitCost) || 0), String(body.supplier || ""), String(body.location || "Main Stockroom"), timestamp, timestamp);
    const newId = Number(result.lastInsertRowid);
    if (Number(body.quantity) > 0) db.prepare(`INSERT INTO stock_transactions
      (consumable_id, type, quantity_change, balance_after, reason, actor_id, created_at) VALUES (?, 'opening', ?, ?, 'Opening balance', ?, ?)`)
      .run(newId, Number(body.quantity), Number(body.quantity), user.id, timestamp);
    audit(user.id, "create", "consumable", newId, null, { code, name }, "Created inventory item");
    return newId;
  });
  return json(response, 201, { id });
}

async function createAsset(request, response, user) {
  const body = await readBody(request);
  const code = normalizeCode(body.code);
  const description = String(body.description || "").trim();
  if (!code || !description) throw new Error("Code and description are required.");
  const timestamp = now();
  const result = db.prepare(`INSERT INTO assets
    (code, description, category, serial_number, condition, purchase_date, purchase_cost, supplier, location, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, description, String(body.category || "Equipment"), String(body.serialNumber || ""), body.condition || "good", body.purchaseDate || null, Math.max(0, Number(body.purchaseCost) || 0), String(body.supplier || ""), String(body.location || "Main Stockroom"), String(body.notes || ""), timestamp, timestamp);
  const id = Number(result.lastInsertRowid);
  audit(user.id, "create", "asset", id, null, { code, description }, "Created asset");
  return json(response, 201, { id });
}

async function changePassword(request, response, user) {
  const body = await readBody(request);
  const record = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
  if (!verifyPassword(String(body.currentPassword || ""), record.password_hash)) return errorResponse(response, 400, "Current password is incorrect.");
  const passwordHash = hashPassword(String(body.newPassword || ""));
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(passwordHash, user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  audit(user.id, "password_change", "user", user.id, null, null, "Password changed by user");
  return json(response, 200, { changed: true }, { "set-cookie": "inventory_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
}

async function createUser(request, response, user) {
  const body = await readBody(request);
  if (!['employee', 'manager', 'custodian', 'admin'].includes(body.role)) throw new Error("Select a valid role.");
  const timestamp = now();
  const result = db.prepare(`INSERT INTO users
    (name, email, password_hash, role, manager_id, backup_approver_id, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(String(body.name || "").trim(), String(body.email || "").trim().toLowerCase(), hashPassword(String(body.temporaryPassword || "")), body.role, body.managerId || null, body.backupApproverId || null, timestamp);
  const id = Number(result.lastInsertRowid);
  audit(user.id, "create", "user", id, null, { name: body.name, email: body.email, role: body.role }, "User created");
  return json(response, 201, { id });
}

async function resetPassword(request, response, user, id) {
  const body = await readBody(request);
  const passwordHash = hashPassword(String(body.temporaryPassword || ""));
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(passwordHash, id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  audit(user.id, "password_reset", "user", id, null, null, "Administrator reset password");
  return json(response, 200, { reset: true });
}

function exportData(response, kind) {
  const queries = {
    inventory: `SELECT code, name, category, quantity, unit, reorder_level, unit_cost, supplier, location FROM consumables ORDER BY code`,
    transactions: `SELECT st.id, c.code, st.type, st.quantity_change, st.balance_after, st.reason, st.request_id, u.email AS actor, st.created_at FROM stock_transactions st JOIN consumables c ON c.id = st.consumable_id JOIN users u ON u.id = st.actor_id ORDER BY st.created_at DESC`,
    custody: `SELECT a.code, a.description, a.category, a.serial_number, a.condition, a.status, u.name AS assigned_to, u.email AS assigned_email, a.due_at, a.location FROM assets a LEFT JOIN users u ON u.id = a.assigned_to ORDER BY a.code`,
    audit: `SELECT al.id, u.email AS actor, al.action, al.entity_type, al.entity_id, al.before_json, al.after_json, al.reason, al.created_at FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id ORDER BY al.created_at DESC`,
  };
  if (!queries[kind]) return errorResponse(response, 404, "Unknown export type.");
  const csv = toCsv(rows(queries[kind]));
  response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="inventory-${kind}.csv"`, "cache-control": "no-store" });
  response.end(`\uFEFF${csv}`);
}

async function importData(request, response, user, kind) {
  const text = await readBody(request, 5_000_000);
  if (typeof text !== "string") throw new Error("CSV import requires a text/csv request body.");
  const parsed = parseCsv(text);
  const report = { imported: 0, failed: 0, errors: [] };
  for (const entry of parsed) {
    try {
      const data = entry.data;
      if (kind === "consumables") {
        const code = normalizeCode(data.code);
        if (!code || !data.name) throw new Error("code and name are required");
        const timestamp = now();
        const result = db.prepare(`INSERT INTO consumables
          (code, name, category, quantity, unit, reorder_level, unit_cost, supplier, location, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(code, data.name, data.category || "General", Math.max(0, Number(data.quantity) || 0), data.unit || "piece", Math.max(0, Number(data.reorder_level) || 0), Math.max(0, Number(data.unit_cost) || 0), data.supplier || "", data.location || "Main Stockroom", timestamp, timestamp);
        audit(user.id, "import", "consumable", Number(result.lastInsertRowid), null, data, `CSV row ${entry.row}`);
      } else if (kind === "assets") {
        const code = normalizeCode(data.code);
        if (!code || !data.description) throw new Error("code and description are required");
        const timestamp = now();
        const result = db.prepare(`INSERT INTO assets
          (code, description, category, serial_number, condition, purchase_date, purchase_cost, supplier, location, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(code, data.description, data.category || "Equipment", data.serial_number || "", data.condition || "good", data.purchase_date || null, Math.max(0, Number(data.purchase_cost) || 0), data.supplier || "", data.location || "Main Stockroom", timestamp, timestamp);
        audit(user.id, "import", "asset", Number(result.lastInsertRowid), null, data, `CSV row ${entry.row}`);
      } else if (kind === "users") {
        if (!data.name || !data.email || !data.role) throw new Error("name, email, and role are required");
        if (!['employee', 'manager', 'custodian', 'admin'].includes(data.role)) throw new Error("invalid role");
        const result = db.prepare(`INSERT INTO users
          (name, email, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
          .run(data.name, data.email.toLowerCase(), hashPassword(data.temporary_password || "ChangeMe123!"), data.role, now());
        audit(user.id, "import", "user", Number(result.lastInsertRowid), null, { name: data.name, email: data.email, role: data.role }, `CSV row ${entry.row}`);
      } else if (kind === "opening-balances") {
        const item = db.prepare("SELECT * FROM consumables WHERE code = ?").get(normalizeCode(data.code));
        if (!item) throw new Error("unknown consumable code");
        const balance = Number(data.quantity);
        if (!Number.isFinite(balance) || balance < 0) throw new Error("quantity must be zero or greater");
        db.prepare("UPDATE consumables SET quantity = ?, updated_at = ? WHERE id = ?").run(balance, now(), item.id);
        db.prepare(`INSERT INTO stock_transactions
          (consumable_id, type, quantity_change, balance_after, reason, actor_id, created_at) VALUES (?, 'opening', ?, ?, 'CSV opening balance', ?, ?)`)
          .run(item.id, balance - item.quantity, balance, user.id, now());
        audit(user.id, "import_balance", "consumable", item.id, { quantity: item.quantity }, { quantity: balance }, `CSV row ${entry.row}`);
      } else {
        throw Object.assign(new Error("Unknown import type."), { status: 404 });
      }
      report.imported += 1;
    } catch (error) {
      report.failed += 1;
      report.errors.push({ row: entry.row, message: error.message });
    }
  }
  return json(response, report.failed ? 207 : 200, report);
}

async function retryEmailOutbox() {
  const webhookUrl = process.env.EMAIL_WEBHOOK_URL;
  if (!webhookUrl) return;
  const queued = rows("SELECT * FROM email_outbox WHERE status IN ('queued','failed') AND attempts < 5 ORDER BY id LIMIT 10");
  for (const message of queued) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(process.env.EMAIL_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.EMAIL_WEBHOOK_TOKEN}` } : {}) },
        body: JSON.stringify({ to: message.recipient, subject: message.subject, text: message.body }),
      });
      if (!response.ok) throw new Error(`Mail provider returned HTTP ${response.status}`);
      db.prepare("UPDATE email_outbox SET status = 'sent', attempts = attempts + 1, last_error = '', sent_at = ? WHERE id = ?").run(now(), message.id);
    } catch (error) {
      db.prepare("UPDATE email_outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?").run(error.message.slice(0, 500), message.id);
    }
  }
}

async function api(request, response, url) {
  if (request.method === "POST" && url.pathname === "/api/login") return login(request, response);
  if (request.method !== "GET" && !requireMutationHeader(request, response)) return;
  const user = requireUser(request, response);
  if (!user) return;
  if (request.method === "POST" && url.pathname === "/api/logout") {
    const token = cookies(request).inventory_session;
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    return json(response, 200, { signedOut: true }, { "set-cookie": "inventory_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") return json(response, 200, getDashboard(user));
  if (request.method === "POST" && url.pathname === "/api/change-password") return changePassword(request, response, user);
  if (request.method === "POST" && url.pathname === "/api/requests") return createRequest(request, response, user);
  let match = url.pathname.match(/^\/api\/requests\/(\d+)\/(approve|reject|cancel|issue)$/);
  if (request.method === "POST" && match) {
    const id = Number(match[1]);
    const action = match[2];
    if (action === "approve" || action === "reject") return decideRequest(request, response, user, id, action === "approve" ? "approved" : "rejected");
    if (action === "cancel") return cancelRequest(request, response, user, id);
    if (!can(user, "request:issue")) return errorResponse(response, 403, "Only custodians and administrators may issue inventory.");
    return issueRequest(request, response, user, id);
  }
  if (request.method === "POST" && url.pathname === "/api/stock/receive") {
    if (!can(user, "stock:write")) return errorResponse(response, 403, "Only custodians and administrators may receive stock.");
    return stockChange(request, response, user, "receive");
  }
  if (request.method === "POST" && url.pathname === "/api/stock/adjust") {
    if (!can(user, "stock:write")) return errorResponse(response, 403, "Only custodians and administrators may adjust stock.");
    return stockChange(request, response, user, "adjust");
  }
  if (request.method === "POST" && url.pathname === "/api/consumables") {
    if (!can(user, "stock:write")) return errorResponse(response, 403, "Only custodians and administrators may create inventory.");
    return createConsumable(request, response, user);
  }
  if (request.method === "POST" && url.pathname === "/api/assets") {
    if (!can(user, "asset:write")) return errorResponse(response, 403, "Only custodians and administrators may create assets.");
    return createAsset(request, response, user);
  }
  match = url.pathname.match(/^\/api\/assets\/(\d+)\/(return|status)$/);
  if (request.method === "POST" && match) {
    if (!can(user, "asset:write")) return errorResponse(response, 403, "Only custodians and administrators may update assets.");
    return match[2] === "return" ? returnAsset(request, response, user, Number(match[1])) : updateAssetStatus(request, response, user, Number(match[1]));
  }
  if (request.method === "POST" && url.pathname === "/api/notifications/read") {
    const body = await readBody(request);
    if (body.id) db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?").run(now(), Number(body.id), user.id);
    else db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(now(), user.id);
    return json(response, 200, { updated: true });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/users") {
    if (user.role !== "admin") return errorResponse(response, 403, "Administrator access required.");
    return json(response, 200, rows(`SELECT u.id, u.name, u.email, u.role, u.active, u.must_change_password, u.manager_id, m.name AS manager_name
      FROM users u LEFT JOIN users m ON m.id = u.manager_id ORDER BY u.name`));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/users") {
    if (user.role !== "admin") return errorResponse(response, 403, "Administrator access required.");
    return createUser(request, response, user);
  }
  match = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
  if (request.method === "POST" && match) {
    if (user.role !== "admin") return errorResponse(response, 403, "Administrator access required.");
    return resetPassword(request, response, user, Number(match[1]));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/email-outbox") {
    if (user.role !== "admin") return errorResponse(response, 403, "Administrator access required.");
    return json(response, 200, rows("SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT 100"));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/email-outbox/retry") {
    if (user.role !== "admin") return errorResponse(response, 403, "Administrator access required.");
    await retryEmailOutbox();
    return json(response, 200, { retried: true });
  }
  match = url.pathname.match(/^\/api\/export\/(inventory|transactions|custody|audit)$/);
  if (request.method === "GET" && match) {
    if (!can(user, "inventory:read") && user.role !== "admin") return errorResponse(response, 403, "Export access requires custodian or administrator permissions.");
    return exportData(response, match[1]);
  }
  match = url.pathname.match(/^\/api\/import\/(consumables|assets|users|opening-balances)$/);
  if (request.method === "POST" && match) {
    if (user.role !== "admin") return errorResponse(response, 403, "Administrator access required for imports.");
    return importData(request, response, user, match[1]);
  }
  return errorResponse(response, 404, "API route not found.");
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = resolve(publicRoot, `.${safePath}`);
  if (!filePath.startsWith(resolve(publicRoot))) return errorResponse(response, 403, "Invalid path.");
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const content = await readFile(filePath);
    response.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream", "cache-control": [".html", ".js", ".css"].includes(extname(filePath)) ? "no-cache" : "public, max-age=3600", "x-content-type-options": "nosniff" });
    response.end(content);
  } catch {
    errorResponse(response, 404, "Page not found.");
  }
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    if (url.pathname.startsWith("/api/")) await api(request, response, url);
    else await serveStatic(response, url.pathname);
  } catch (error) {
    const constraint = String(error.message).includes("UNIQUE constraint failed");
    console.error(error);
    errorResponse(response, error.status || (constraint ? 409 : 400), constraint ? "That code or email is already in use." : error.message || "The request could not be completed.");
  }
}

let server;
if (process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH) {
  server = createHttpsServer({ cert: await readFile(process.env.TLS_CERT_PATH), key: await readFile(process.env.TLS_KEY_PATH) }, handle);
} else {
  server = createHttpServer(handle);
}

setInterval(() => {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
  retryEmailOutbox().catch(console.error);
}, 60_000).unref();

server.listen(port, host, () => {
  const protocol = process.env.TLS_CERT_PATH ? "https" : "http";
  console.log(`Inventory Hub is running at ${protocol}://${host}:${port}`);
});
