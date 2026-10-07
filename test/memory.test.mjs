// Offline test of the server's tools. Needs only Node 22+: node --test
import worker from "../src/index.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const DB = { prepare(sql) { let p = []; const a = { bind: (...x) => { p = x; return a; }, run: async () => { sqlite.prepare(sql).run(...p); return {}; }, first: async () => sqlite.prepare(sql).get(...p) ?? null, all: async () => ({ results: sqlite.prepare(sql).all(...p) }) }; return a; } };
const env = { MEMORY_KEY: "k", TIMEZONE: "America/New_York", DB };
let n = 0;
async function call(name, args, e = env) {
  const res = await worker.fetch(new Request("https://m.test/mcp/k", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) }), e);
  const j = await res.json();
  return { text: j.result.content[0].text, isError: !!j.result.isError };
}
const idOf = (t) => t.match(/\[([0-9a-f]{8})\]/)[1];
const row = (id) => sqlite.prepare("SELECT * FROM memory WHERE id = ?").get(id);
const day = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// save: plain, defaults to confirmed, no expiry, checked now
let r = await call("memory_save", { text: "Sam likes steel bikes.", category: "Preferences", source: "claude" });
assert.ok(!r.isError && r.text.startsWith("Saved:"));
const a = idOf(r.text);
assert.equal(row(a).status, "confirmed"); assert.equal(row(a).category, "preferences"); assert.equal(row(a).expires_on, null); assert.ok(row(a).checked_at);

// duplicate text (any case) is not saved twice
r = await call("memory_save", { text: "sam likes STEEL bikes." });
assert.ok(r.text.startsWith("Already saved")); assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM memory").get().n, 1);

// inference: by flag, and by the "(unconfirmed)" prefix
r = await call("memory_save", { text: "His girlfriend may be named Alex.", category: "people", confirmed: false });
const b = idOf(r.text); assert.equal(row(b).status, "unconfirmed"); assert.ok(r.text.includes("unconfirmed"));
r = await call("memory_save", { text: "(unconfirmed) He may prefer window seats." });
assert.equal(row(idOf(r.text)).status, "unconfirmed");

// expiry: valid date kept, bad date refused
r = await call("memory_save", { text: "Fall classes: PHIL Mon/Wed.", category: "school", expires: day(30) });
const c = idOf(r.text); assert.equal(row(c).expires_on, day(30)); assert.ok(r.text.includes(`expires ${day(30)}`));
assert.ok((await call("memory_save", { text: "bad date note", expires: "next week" })).isError);

// tasks are still refused
assert.ok((await call("memory_save", { text: "TASK: buy milk" })).isError);
assert.ok((await call("memory_save", { text: "do it", category: "task" })).isError);

// update: only the id = mark as checked, nothing else changes
const before = row(a);
await new Promise((res) => setTimeout(res, 5));
r = await call("memory_update", { id: a });
assert.ok(!r.isError); assert.equal(row(a).text, before.text); assert.equal(row(a).updated_at, before.updated_at); assert.ok(row(a).checked_at > before.checked_at);

// update: category only (archive), confirm an inference, set and clear expiry, change text
await call("memory_update", { id: a, category: "archive" }); assert.equal(row(a).category, "archive"); assert.equal(row(a).text, before.text);
await call("memory_update", { id: b, confirmed: true }); assert.equal(row(b).status, "confirmed");
await call("memory_update", { id: b, expires: day(-1) }); assert.equal(row(b).expires_on, day(-1));
assert.ok((await call("memory_list", {})).text.includes("EXPIRED"));
await call("memory_update", { id: b, expires: "none" }); assert.equal(row(b).expires_on, null);
assert.ok((await call("memory_update", { id: b, expires: "soon" })).isError);
r = await call("memory_update", { id: b, text: "His girlfriend is named Alex.", source: "chatgpt" });
assert.equal(row(b).text, "His girlfriend is named Alex."); assert.equal(row(b).source, "chatgpt");
assert.ok((await call("memory_update", { id: b, text: "   " })).isError);
assert.ok((await call("memory_update", { id: "nope0000", text: "x" })).isError);

// search and list: archive is still found, category filter works
assert.ok((await call("memory_search", { query: "steel" })).text.includes("steel bikes"));
assert.ok((await call("memory_list", { category: "school" })).text.startsWith("1 fact(s)"));
assert.equal((await call("memory_search", { query: "zzzz" })).text, "No matching facts.");

// recent: newest first across memory, tasks and bills, with how long ago
await new Promise((res) => setTimeout(res, 5));
await call("task_add", { title: "Call the dentist" });
await new Promise((res) => setTimeout(res, 5));
await call("bill_add", { name: "Rent", amount: 900 });
r = await call("memory_recent", {});
const recent = r.text.split("\n");
assert.ok(recent[1].startsWith("0 min ago, added bill:") && recent[1].includes("Rent"));
assert.ok(recent[2].includes("added task:") && recent[2].includes("Call the dentist"));
assert.ok(recent[3].includes("changed memory:") && recent[3].includes("Alex"));
assert.equal((await call("memory_recent", { limit: 2 })).text.split("\n").length, 3);

// delete
r = await call("memory_delete", { id: c }); assert.ok(r.text.startsWith("Deleted")); assert.equal(row(c), undefined);
assert.ok((await call("memory_delete", { id: c })).isError);

// no database: clear error, not a crash
assert.ok((await call("memory_list", {}, { MEMORY_KEY: "k" })).isError);

// a wrong key gets nothing
assert.equal((await worker.fetch(new Request("https://m.test/mcp/wrong", { method: "POST", body: "{}" }), env)).status, 404);

console.log("all tests passed");
