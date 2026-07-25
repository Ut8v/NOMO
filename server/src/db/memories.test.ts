import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomo-memories-test-"));
process.env.NOMO_DATA_DIR = tempDir;

let db: typeof import("./index.js");
let memories: typeof import("./memories.js");

before(async () => {
  db = await import("./index.js");
  db.initDatabase();
  memories = await import("./memories.js");
});

beforeEach(() => {
  db.getDb().prepare("DELETE FROM memories").run();
});

test("a remembered fact is injectable; pending and inactive ones are not", () => {
  memories.createMemory({ content: "Prefers low risk", source: "conversation", status: "approved" });
  memories.createMemory({ content: "Distilled candidate", source: "distilled", status: "pending" });
  const inactive = memories.createMemory({ content: "Old note", source: "conversation", status: "approved" });
  memories.updateMemory(inactive.id, { active: false });

  const injectable = memories.listInjectableMemories();
  assert.deepEqual(injectable, ["Prefers low risk"]);
});

test("injectable memories read oldest to newest", () => {
  memories.createMemory({ content: "first", source: "conversation", status: "approved" });
  memories.createMemory({ content: "second", source: "conversation", status: "approved" });
  assert.deepEqual(memories.listInjectableMemories(), ["first", "second"]);
});

test("injection is capped to a character budget, newest kept", () => {
  const big = "x".repeat(1200);
  memories.createMemory({ content: `old ${big}`, source: "conversation", status: "approved" });
  memories.createMemory({ content: `new ${big}`, source: "conversation", status: "approved" });
  const injectable = memories.listInjectableMemories();
  // Both do not fit in the ~1600 char budget; the newest is kept.
  assert.equal(injectable.length, 1);
  assert.match(injectable[0]!, /^new /);
});

test("approving a pending memory makes it injectable", () => {
  const memory = memories.createMemory({ content: "watch NVDA", source: "distilled", status: "pending" });
  assert.deepEqual(memories.listInjectableMemories(), []);
  memories.updateMemory(memory.id, { status: "approved" });
  assert.deepEqual(memories.listInjectableMemories(), ["watch NVDA"]);
});

test("editing content updates what is injected", () => {
  const memory = memories.createMemory({ content: "typo", source: "conversation", status: "approved" });
  memories.updateMemory(memory.id, { content: "fixed" });
  assert.deepEqual(memories.listInjectableMemories(), ["fixed"]);
});
