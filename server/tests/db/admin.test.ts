import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomo-admin-test-"));
process.env.NOMO_DATA_DIR = tempDir;

let admin: typeof import("../../src/db/admin.js");
let credentials: typeof import("../../src/db/credentials.js");
let auditLog: typeof import("../../src/db/auditLog.js");

before(async () => {
  const dbModule = await import("../../src/db/index.js");
  dbModule.initDatabase();
  admin = await import("../../src/db/admin.js");
  credentials = await import("../../src/db/credentials.js");
  auditLog = await import("../../src/db/auditLog.js");
  // Store a real-looking secret to prove it never comes back out.
  credentials.setCredential("anthropic", "sk-ant-super-secret-value");
  credentials.setCredential("polygon", "polygon-secret-key");
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("browsable tables include app tables and exclude sqlite and fts internals", () => {
  const names = admin.listBrowsableTables().map((t) => t.name);
  assert.ok(names.includes("audit_log"));
  assert.ok(names.includes("pending_orders"));
  assert.ok(names.includes("credentials"));
  for (const name of names) {
    assert.ok(!name.startsWith("sqlite_"), `${name} is a sqlite internal`);
    assert.ok(!name.includes("fts"), `${name} is an fts shadow table`);
  }
});

test("the credentials secret is never returned, only redacted", () => {
  const page = admin.getTablePage("credentials");
  assert.ok(page.columns.includes("secret"));
  assert.ok(page.rows.length >= 2);
  for (const row of page.rows) {
    assert.equal(row.secret, "[redacted]");
  }
  // The real secret must appear nowhere in the serialized page.
  const serialized = JSON.stringify(page);
  assert.doesNotMatch(serialized, /sk-ant-super-secret-value/);
  assert.doesNotMatch(serialized, /polygon-secret-key/);
});

test("rows come back newest first and paginate", () => {
  // Two audit rows; the later insert has the higher rowid and must sort first.
  auditLog.recordToolCall({ toolName: "first_tool", tier: "market_data", params: {}, outcome: "ok" });
  auditLog.recordToolCall({ toolName: "second_tool", tier: "market_data", params: {}, outcome: "ok" });

  const page = admin.getTablePage("audit_log", 1, 0);
  assert.equal(page.limit, 1);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0]?.tool_name, "second_tool");
  assert.ok(page.total >= 2);

  const next = admin.getTablePage("audit_log", 1, 1);
  assert.equal(next.rows[0]?.tool_name, "first_tool");
});

test("an unknown or fts table is rejected", () => {
  assert.throws(() => admin.getTablePage("does_not_exist"), /non-browsable/);
  assert.throws(() => admin.getTablePage("sqlite_master"), /non-browsable/);
});

test("limit is clamped to a sane maximum", () => {
  const page = admin.getTablePage("audit_log", 100000, 0);
  assert.ok(page.limit <= 200);
});
