export const ROLES = Object.freeze(["employee", "manager", "custodian", "admin"]);
export const REQUEST_STATUSES = Object.freeze(["pending", "approved", "rejected", "partially_issued", "issued", "cancelled"]);
export const ASSET_STATUSES = Object.freeze(["available", "assigned", "loaned", "maintenance", "retired"]);
export const CONDITIONS = Object.freeze(["new", "good", "fair", "damaged"]);

export function can(user, action) {
  if (!user || !ROLES.includes(user.role)) return false;
  if (user.role === "admin") return true;
  const allowed = {
    employee: ["request:create", "request:cancel", "own:read"],
    manager: ["request:create", "request:cancel", "request:approve", "own:read", "team:read"],
    custodian: ["request:create", "request:cancel", "stock:write", "asset:write", "request:issue", "inventory:read", "audit:read"],
  };
  return allowed[user.role]?.includes(action) ?? false;
}

export function validateRequestTransition(current, next) {
  const transitions = {
    pending: ["approved", "rejected", "cancelled"],
    approved: ["partially_issued", "issued", "cancelled"],
    partially_issued: ["partially_issued", "issued", "cancelled"],
    rejected: [],
    issued: [],
    cancelled: [],
  };
  if (!REQUEST_STATUSES.includes(current) || !transitions[current]?.includes(next)) {
    throw new Error(`Cannot move a request from ${current} to ${next}.`);
  }
  return next;
}

export function normalizeCode(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "-");
}

export function requirePositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than zero.`);
  return number;
}

export function calculateIssue(requested, previouslyIssued, issueNow, available) {
  const requestedQuantity = requirePositiveNumber(requested, "Requested quantity");
  const issuedQuantity = Math.max(0, Number(previouslyIssued) || 0);
  const newQuantity = requirePositiveNumber(issueNow, "Issue quantity");
  const stock = Math.max(0, Number(available) || 0);
  if (newQuantity > stock) throw new Error("There is not enough stock to issue this quantity.");
  if (issuedQuantity + newQuantity > requestedQuantity) throw new Error("Issue quantity exceeds the amount requested.");
  const totalIssued = issuedQuantity + newQuantity;
  return {
    totalIssued,
    remainingStock: stock - newQuantity,
    status: totalIssued === requestedQuantity ? "issued" : "partially_issued",
  };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"' && quoted && input[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted value.");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error("CSV must include a header and at least one data row.");
  const headers = rows[0].map((header) => header.toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map((values, index) => ({
    row: index + 2,
    data: Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""])),
  }));
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\r\n");
}
