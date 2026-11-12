import test from "node:test";
import assert from "node:assert/strict";
import { calculateIssue, can, normalizeCode, parseCsv, validateRequestTransition } from "../core.js";

test("role permissions prevent employees from changing stock", () => {
  assert.equal(can({ role: "employee" }, "stock:write"), false);
  assert.equal(can({ role: "custodian" }, "stock:write"), true);
  assert.equal(can({ role: "admin" }, "stock:write"), true);
});

test("request transitions reject invalid workflow shortcuts", () => {
  assert.equal(validateRequestTransition("pending", "approved"), "approved");
  assert.throws(() => validateRequestTransition("pending", "issued"), /Cannot move/);
  assert.throws(() => validateRequestTransition("rejected", "approved"), /Cannot move/);
});

test("partial issues never create negative stock or over-issue", () => {
  assert.deepEqual(calculateIssue(10, 2, 3, 8), {
    totalIssued: 5,
    remainingStock: 5,
    status: "partially_issued",
  });
  assert.throws(() => calculateIssue(10, 2, 9, 8), /enough stock/);
  assert.throws(() => calculateIssue(10, 8, 3, 20), /exceeds/);
});

test("manual codes are normalized consistently", () => {
  assert.equal(normalizeCode("  lap top 001 "), "LAP-TOP-001");
});

test("CSV parser supports quoted commas and reports malformed input", () => {
  assert.deepEqual(parseCsv('code,name\nP-1,"Paper, A4"')[0].data, { code: "P-1", name: "Paper, A4" });
  assert.throws(() => parseCsv('code,name\nP-1,"Paper'), /unterminated/);
});
