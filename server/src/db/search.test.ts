import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomo-search-test-"));
process.env.NOMO_DATA_DIR = tempDir;

let db: typeof import("./index.js");
let conversations: typeof import("./conversations.js");
let search: typeof import("./search.js");

before(async () => {
  db = await import("./index.js");
  db.initDatabase();
  conversations = await import("./conversations.js");
  search = await import("./search.js");
});

beforeEach(() => {
  db.getDb().prepare("DELETE FROM conversations").run();
  db.getDb().prepare("DELETE FROM messages_fts").run();
});

function seed(title: string, texts: string[]): string {
  const conversation = conversations.createConversation(title);
  conversations.replaceMessages(
    conversation.id,
    texts.map((text) => ({ role: "user" as const, blocks: [{ kind: "text", text }] })),
  );
  return conversation.id;
}

test("search finds a conversation by a message keyword", () => {
  seed("Momentum chat", ["Let us look at the momentum breakout on NVDA"]);
  const hits = search.searchMessages("breakout");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.title, "Momentum chat");
  assert.match(hits[0]!.snippet, /breakout/i);
});

test("search matches all terms and ignores punctuation", () => {
  seed("A", ["Apple earnings were strong"]);
  seed("B", ["Tesla delivery numbers"]);
  const hits = search.searchMessages("apple, earnings!");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.title, "A");
});

test("non-text blocks are not indexed", () => {
  const id = conversations.createConversation("Chart only").id;
  conversations.replaceMessages(id, [
    { role: "assistant", blocks: [{ kind: "chart", spec: { ticker: "AAPL" } }] },
  ]);
  assert.deepEqual(search.searchMessages("AAPL"), []);
});

test("editing a conversation updates the index", () => {
  const id = seed("Editable", ["original wording"]);
  conversations.replaceMessages(id, [{ role: "user", blocks: [{ kind: "text", text: "revised wording" }] }]);
  assert.deepEqual(search.searchMessages("original"), []);
  assert.equal(search.searchMessages("revised").length, 1);
});

test("deleting a conversation removes it from the index", () => {
  const id = seed("Doomed", ["find me if you can"]);
  assert.equal(search.searchMessages("find").length, 1);
  conversations.deleteConversation(id);
  assert.deepEqual(search.searchMessages("find"), []);
});

test("a query with no usable terms returns nothing", () => {
  seed("X", ["hello world"]);
  assert.deepEqual(search.searchMessages("!!! ###"), []);
});
