// Shared Memory: an MCP server on a Cloudflare Worker.
// One memory (plus tasks and bills) that Claude, ChatGPT and any other MCP client can all
// read and write. Data lives in a D1 database (binding DB, tables in ../schema.sql).
// Setup is in README.md. Connector URL: https://<worker>.workers.dev/mcp/<MEMORY_KEY>

const SERVER = { name: "shared-memory", version: "1.2.0" };
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_FACTS = 2000;
const MAX_TEXT = 2000;

const TOOLS = [
  {
    name: "memory_save",
    description:
      "Save a durable fact about the user to their shared memory (one memory for every assistant connected to it). " +
      "Use for lasting things: preferences, people, schedules, accounts in use, ongoing projects, decisions. " +
      "Never save passwords, card or account numbers, SSNs, or other secrets. Check memory_search first to avoid duplicates; use memory_update to change an existing fact.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, written as one clear sentence. At most 2,000 characters; longer text is refused, not cut." },
        category: {
          type: "string",
          description:
            "One short lowercase category, e.g. school, money, work, car, preferences, people, health, travel, other. " +
            "Use 'archive' for notes about finished things kept only for reference: memory_search skips them unless it asks for category 'archive'.",
        },
        source: { type: "string", description: "Who is saving it: 'claude' or 'chatgpt'." },
        confirmed: {
          type: "boolean",
          description: "Leave out (true) when the user said it or a record shows it. Set false when it is your own inference or guess, so it is marked unconfirmed.",
        },
        expires: {
          type: "string",
          description: "Optional YYYY-MM-DD after which this stops being true (a semester schedule, a delivery window, a trial). Expired notes are flagged as probably no longer true.",
        },
      },
      required: ["text"],
    },
    annotations: { title: "Save to shared memory", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "memory_search",
    description:
      "Search the user's shared memory by keywords. Use at the start of a conversation when personal context would help, and before saving to avoid duplicates. " +
      "Archived notes (finished things) are skipped unless you pass category 'archive'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to look for." },
        category: { type: "string", description: "Optional category filter." },
        limit: { type: "integer", description: "Max results (default 20).", minimum: 1, maximum: 100 },
      },
      required: ["query"],
    },
    annotations: { title: "Search shared memory", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "memory_list",
    description: "List facts in the user's shared memory, newest first, optionally by category.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional category filter." },
        limit: { type: "integer", description: "Max results (default 50).", minimum: 1, maximum: 500 },
      },
    },
    annotations: { title: "List shared memory", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "memory_update",
    description:
      "Change an existing fact by its id. Send only what changes: text, category, confirmed, or expires. " +
      "Sending just the id marks the fact as checked and still true today. Use when something changed or when the user confirms a fact.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The fact's id from search or list." },
        text: { type: "string", description: "The new text, at most 2,000 characters. Leave out to keep the current text." },
        category: { type: "string", description: "Optional new category. Use 'archive' for a finished thing; memory_search then skips it unless it asks for category 'archive'." },
        source: { type: "string", description: "'claude' or 'chatgpt'." },
        confirmed: { type: "boolean", description: "true once the user confirms it; false to mark it as an inference." },
        expires: { type: "string", description: "YYYY-MM-DD after which it stops being true, or 'none' to clear." },
      },
      required: ["id"],
    },
    annotations: { title: "Update shared memory", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "memory_delete",
    description: "Delete a fact by id. Only when the user asks to forget something or a fact is clearly wrong.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The fact's id." } },
      required: ["id"],
    },
    annotations: { title: "Delete from shared memory", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "memory_recent",
    description:
      "Show what was added or changed most recently across the user's memory, tasks and bills, newest first, with how long ago. " +
      "Call this FIRST, before any search, whenever they refer to something they just saved or just told you or another chat " +
      "('the thing I just added', 'what I saved earlier', 'I told ChatGPT a minute ago').",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max results (default 10).", minimum: 1, maximum: 50 } },
    },
    annotations: { title: "Recently saved", readOnlyHint: true, openWorldHint: false },
  },
  // ---- Tasks ----
  {
    name: "task_add",
    description:
      "Add a task to the user's task database. Use this for anything they need to do or asked you to handle (never memory_save). " +
      "Check task_list first so you don't duplicate an existing task; use task_update to change one.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What needs to happen, one clear line." },
        due: { type: "string", description: "Due date in the user's local time: YYYY-MM-DD or YYYY-MM-DDTHH:MM (24h). Omit if there is none." },
        next_step: { type: "string", description: "The single next concrete step." },
        status: { type: "string", enum: ["open", "waiting"], description: "open (default), or waiting if the next step needs the user." },
        source: { type: "string", description: "'user' if they asked for it, 'proactive' if you noticed it yourself." },
        notes: { type: "string", description: "Optional longer context: plans, links, options." },
        by: { type: "string", description: "Who is writing: 'claude' or 'chatgpt'." },
      },
      required: ["title"],
    },
    annotations: { title: "Add a task", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "task_list",
    description:
      "List the user's tasks, soonest due first. Default shows active tasks (open and waiting). Use before adding a task and whenever they ask what's on their plate.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "open", "waiting", "done", "dropped", "all"], description: "Default active (open + waiting)." },
        due_within_days: { type: "integer", description: "Only tasks due within this many days (overdue included).", minimum: 0, maximum: 365 },
        limit: { type: "integer", description: "Max results (default 50).", minimum: 1, maximum: 200 },
      },
    },
    annotations: { title: "List tasks", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "task_get",
    description: "Get one task in full by id: notes, next step, and its dated log of what has been done.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The task id from task_list." } },
      required: ["id"],
    },
    annotations: { title: "Get a task", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "task_update",
    description:
      "Update a task by id: change its status (open, waiting = needs the user, done, dropped), due date, next step, title or notes, " +
      "and/or append a log note saying what happened. Mark finished tasks done instead of deleting them.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task id from task_list." },
        status: { type: "string", enum: ["open", "waiting", "done", "dropped"] },
        due: { type: "string", description: "New due date, local time: YYYY-MM-DD or YYYY-MM-DDTHH:MM. Use 'none' to clear it." },
        next_step: { type: "string" },
        title: { type: "string" },
        notes: { type: "string", description: "Replaces the notes field." },
        log: { type: "string", description: "A short note on what was just done or decided. Appended with today's date." },
        by: { type: "string", description: "'claude' or 'chatgpt'." },
      },
      required: ["id"],
    },
    annotations: { title: "Update a task", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  // ---- Bills ----
  {
    name: "bill_add",
    description:
      "Record a bill or statement the user owes (card statement, rent, subscription renewal, tuition). Call bill_list first and use bill_update if it is already there. " +
      "Never store card or account numbers.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Who it's owed to and what it is, e.g. 'Capital One Quicksilver statement'." },
        amount: { type: "number", description: "Dollars owed. Omit if unknown." },
        due: { type: "string", description: "Due date: YYYY-MM-DD. Omit if unknown." },
        autopay: { type: "boolean", description: "True only if autopay will cover the full amount." },
        notes: { type: "string", description: "Anything useful: partial autopay, where to pay, what's uncovered." },
        source: { type: "string", description: "'user' if they told you, 'proactive' if you found it." },
      },
      required: ["name"],
    },
    annotations: { title: "Add a bill", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "bill_list",
    description: "List the user's bills, soonest due first. Default shows unpaid ones.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["due", "paid", "skipped", "all"], description: "Default due." },
        due_within_days: { type: "integer", description: "Only bills due within this many days (overdue included).", minimum: 0, maximum: 365 },
      },
    },
    annotations: { title: "List bills", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "bill_update",
    description: "Update a bill by id: mark it paid or skipped, or change its amount, due date, autopay flag or notes. Only mark paid when the user says they paid or a record confirms it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The bill id from bill_list." },
        status: { type: "string", enum: ["due", "paid", "skipped"] },
        amount: { type: "number" },
        due: { type: "string", description: "YYYY-MM-DD, or 'none' to clear." },
        autopay: { type: "boolean" },
        notes: { type: "string", description: "Replaces the notes field." },
        name: { type: "string" },
      },
      required: ["id"],
    },
    annotations: { title: "Update a bill", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

// ---------- Bills (D1) ----------

const BILL_DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
const money = (n) => (n == null ? "amount unknown" : `$${Number(n).toFixed(2)}`);
const fmtBill = (b) =>
  `[${b.id}] (${b.status}) ${b.name} | ${money(b.amount)} | due: ${b.due_at || "unknown"}${b.autopay ? " | autopay" : ""}${b.notes ? ` | ${b.notes}` : ""}`;

// undefined = not given, null = clear, string = valid. Throws on a bad format.
function parseBillDue(v) {
  if (v === undefined || v === null || String(v).trim() === "") return undefined;
  const s = String(v).trim();
  if (/^none$/i.test(s)) return null;
  if (!BILL_DUE_RE.test(s)) throw new Error(`due must be YYYY-MM-DD (got "${s.slice(0, 40)}")`);
  return s;
}
function parseAmount(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("amount must be a number of dollars, zero or more");
  return Math.round(n * 100) / 100;
}

async function callBillTool(name, args, env) {
  if (!env.DB) return err("The database is not connected (D1 binding DB is missing).");
  const now = new Date().toISOString();
  let due, amount;
  try {
    due = parseBillDue(args.due);
    amount = parseAmount(args.amount);
  } catch (e) {
    return err(e.message);
  }

  if (name === "bill_add") {
    const billName = clean(args.name, 200);
    if (!billName) return err("name is required");
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO bills (id, name, amount, due_at, autopay, notes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, billName, amount ?? null, due ?? null, args.autopay ? 1 : 0, clean(args.notes, 1000) || null, clean(args.source, 20).toLowerCase() || null, now, now)
      .run();
    return ok(`Added: ${fmtBill(await env.DB.prepare("SELECT * FROM bills WHERE id = ?").bind(id).first())}`);
  }

  if (name === "bill_list") {
    const status = clean(args.status, 20).toLowerCase() || "due";
    const where = [];
    const binds = [];
    if (["due", "paid", "skipped"].includes(status)) {
      where.push("status = ?");
      binds.push(status);
    } else if (status !== "all") return err("status must be due, paid, skipped or all");
    if (args.due_within_days !== undefined && args.due_within_days !== null) {
      const days = Math.max(0, Math.min(Number(args.due_within_days) || 0, 365));
      where.push("due_at IS NOT NULL AND due_at <= ?");
      binds.push(new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: TZ }));
    }
    const { results } = await env.DB.prepare(
      `SELECT * FROM bills ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY (due_at IS NULL), due_at, updated_at DESC LIMIT 100`
    ).bind(...binds).all();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    return ok(results.length ? `${results.length} bill(s), today is ${today}:\n${results.map(fmtBill).join("\n")}` : "No matching bills.");
  }

  if (name === "bill_update") {
    const id = clean(args.id, 20);
    const bill = id ? await env.DB.prepare("SELECT * FROM bills WHERE id = ?").bind(id).first() : null;
    if (!bill) return err("No bill with that id. Use bill_list to find it.");
    const sets = [];
    const binds = [];
    if (args.status !== undefined) {
      const status = clean(args.status, 20).toLowerCase();
      if (!["due", "paid", "skipped"].includes(status)) return err("status must be due, paid or skipped");
      sets.push("status = ?", "paid_at = ?");
      binds.push(status, status === "paid" ? now : null);
    }
    if (amount !== undefined) { sets.push("amount = ?"); binds.push(amount); }
    if (due !== undefined) { sets.push("due_at = ?"); binds.push(due); }
    if (args.autopay !== undefined) { sets.push("autopay = ?"); binds.push(args.autopay ? 1 : 0); }
    if (args.notes !== undefined) { sets.push("notes = ?"); binds.push(clean(args.notes, 1000) || null); }
    if (args.name !== undefined && clean(args.name, 200)) { sets.push("name = ?"); binds.push(clean(args.name, 200)); }
    if (!sets.length) return err("Nothing to change.");
    sets.push("updated_at = ?");
    binds.push(now);
    await env.DB.prepare(`UPDATE bills SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
    return ok(`Updated: ${fmtBill(await env.DB.prepare("SELECT * FROM bills WHERE id = ?").bind(id).first())}`);
  }

  return null;
}

// ---------- Tasks (D1) ----------

let TZ = "UTC"; // set on every request from the TIMEZONE variable
const DUE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const TASK_STATUSES = ["open", "waiting", "done", "dropped"];
const fmtTask = (t) =>
  `[${t.id}] (${t.status}) ${t.title} | due: ${t.due_at || "none"} | next: ${t.next_step || "-"} | updated ${t.updated_at.slice(0, 10)}`;

// undefined = not given, null = clear it, string = valid value. Throws on a bad format.
function parseDueArg(v) {
  if (v === undefined || v === null || String(v).trim() === "") return undefined;
  const s = String(v).trim();
  if (/^none$/i.test(s)) return null;
  if (!DUE_RE.test(s)) throw new Error(`due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM (got "${s.slice(0, 40)}")`);
  return s;
}

async function logTask(env, taskId, now, by, note) {
  await env.DB.prepare("INSERT INTO task_log (task_id, at, by, note) VALUES (?, ?, ?, ?)").bind(taskId, now, by, note).run();
}

async function callTaskTool(name, args, env) {
  if (!env.DB) return err("The task database is not connected (D1 binding DB is missing).");
  const now = new Date().toISOString();
  const by = clean(args.by, 20) || "unknown";

  if (name === "task_add") {
    const title = clean(args.title, 300);
    if (!title) return err("title is required");
    let due;
    try {
      due = parseDueArg(args.due);
    } catch (e) {
      return err(e.message);
    }
    const status = args.status === "waiting" ? "waiting" : "open";
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO tasks (id, title, status, due_at, next_step, notes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, title, status, due ?? null, clean(args.next_step, 1000) || null, clean(args.notes, 4000) || null, clean(args.source, 20).toLowerCase() || null, now, now)
      .run();
    await logTask(env, id, now, by, "created");
    const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
    return ok(`Added: ${fmtTask(t)}`);
  }

  if (name === "task_list") {
    const status = clean(args.status, 20).toLowerCase() || "active";
    const where = [];
    const binds = [];
    if (status === "active") where.push("status IN ('open', 'waiting')");
    else if (TASK_STATUSES.includes(status)) {
      where.push("status = ?");
      binds.push(status);
    } else if (status !== "all") return err("status must be active, open, waiting, done, dropped or all");
    if (args.due_within_days !== undefined && args.due_within_days !== null) {
      const days = Math.max(0, Math.min(Number(args.due_within_days) || 0, 365));
      const cutoff = new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
      where.push("due_at IS NOT NULL AND due_at <= ?");
      binds.push(`${cutoff}T23:59`);
    }
    const limit = Math.min(Number(args.limit) || 50, 200);
    const sql =
      `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
      `ORDER BY (due_at IS NULL), due_at, updated_at DESC LIMIT ${limit}`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    return ok(results.length ? `${results.length} task(s), today is ${today}:\n${results.map(fmtTask).join("\n")}` : "No matching tasks.");
  }

  const id = clean(args.id, 20);
  const task = id ? await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first() : null;
  if (!task) return err("No task with that id. Use task_list to find it.");

  if (name === "task_get") {
    const { results } = await env.DB.prepare("SELECT at, by, note FROM task_log WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT 30").bind(id).all();
    const lines = [
      fmtTask(task),
      `source: ${task.source || "-"} | created ${task.created_at.slice(0, 10)}${task.done_at ? ` | done ${task.done_at.slice(0, 10)}` : ""}`,
      task.notes ? `notes: ${task.notes}` : null,
      "log (newest first):",
      ...results.map((l) => `- ${l.at.slice(0, 10)} (${l.by || "?"}) ${l.note}`),
    ];
    return ok(lines.filter((x) => x != null).join("\n"));
  }

  if (name === "task_update") {
    const sets = [];
    const binds = [];
    const changes = [];
    let due;
    try {
      due = parseDueArg(args.due);
    } catch (e) {
      return err(e.message);
    }
    if (args.status !== undefined) {
      const status = clean(args.status, 20).toLowerCase();
      if (!TASK_STATUSES.includes(status)) return err("status must be open, waiting, done or dropped");
      if (status !== task.status) {
        sets.push("status = ?", "done_at = ?");
        binds.push(status, status === "done" ? now : null);
        changes.push(`status ${task.status} -> ${status}`);
      }
    }
    if (due !== undefined && due !== task.due_at) {
      sets.push("due_at = ?");
      binds.push(due);
      changes.push(`due ${task.due_at || "none"} -> ${due || "none"}`);
    }
    if (args.next_step !== undefined) {
      sets.push("next_step = ?");
      binds.push(clean(args.next_step, 1000) || null);
    }
    if (args.title !== undefined && clean(args.title, 300)) {
      sets.push("title = ?");
      binds.push(clean(args.title, 300));
      changes.push("title changed");
    }
    if (args.notes !== undefined) {
      sets.push("notes = ?");
      binds.push(clean(args.notes, 4000) || null);
    }
    const note = clean(args.log, 1000);
    if (!sets.length && !note) return err("Nothing to change. Give a field to update or a log note.");
    sets.push("updated_at = ?");
    binds.push(now);
    await env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
    const entry = [changes.join("; "), note].filter(Boolean).join(". ");
    if (entry) await logTask(env, id, now, by, entry);
    const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
    return ok(`Updated: ${fmtTask(t)}`);
  }

  return null;
}

// ---- Memory notes (D1 table "memory"; one row per note) ----

const clean = (s, n = MAX_TEXT) => String(s ?? "").trim().slice(0, n);
// Note text over the limit is refused, never cut: a silent cut once lost the end of a note.
const tooLong = (s) => {
  const n = String(s ?? "").trim().length;
  return n > MAX_TEXT ? `That note is ${n.toLocaleString("en-US")} characters; the limit is ${MAX_TEXT.toLocaleString("en-US")}. Shorten it or split it into two notes.` : null;
};
const cat = (s) => clean(s, 40).toLowerCase() || "other";
const newId = () => crypto.randomUUID().slice(0, 8);
const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const isExpired = (f) => Boolean(f.expires_on) && f.expires_on < todayLocal();
const ago = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `${min} min ago` : min < 2880 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

function fmt(f) {
  const flags = [];
  if (f.status === "unconfirmed") flags.push("unconfirmed: an assistant's inference, not something the user said");
  if (isExpired(f)) flags.push(`EXPIRED ${f.expires_on}, probably no longer true`);
  else if (f.expires_on) flags.push(`expires ${f.expires_on}`);
  return `[${f.id}] (${f.category}) ${f.text}  (updated ${String(f.updated_at).slice(0, 10)} by ${f.source || "unknown"}${flags.length ? "; " + flags.join("; ") : ""})`;
}

function score(fact, words) {
  const hay = `${fact.text} ${fact.category}`.toLowerCase();
  let s = 0;
  for (const w of words) if (hay.includes(w)) s++;
  return s;
}

// "YYYY-MM-DD" -> that date, "none" or "" -> null (clears it), anything else -> undefined (invalid).
function parseExpires(v) {
  const s = clean(v, 20).toLowerCase();
  if (!s || s === "none") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
}

async function loadFacts(env, category) {
  const stmt = category
    ? env.DB.prepare("SELECT * FROM memory WHERE category = ? ORDER BY updated_at DESC").bind(category)
    : env.DB.prepare("SELECT * FROM memory ORDER BY updated_at DESC");
  return (await stmt.all()).results || [];
}

async function callTool(name, args, env) {
  args = args || {};
  if (typeof name === "string" && name.startsWith("task_")) return callTaskTool(name, args, env);
  if (typeof name === "string" && name.startsWith("bill_")) return callBillTool(name, args, env);
  if (typeof name !== "string" || !name.startsWith("memory_")) return null; // unknown tool
  if (!env.DB) return err("The database is not connected to this server (missing DB binding).");
  const now = new Date().toISOString();

  if (name === "memory_save") {
    const long = tooLong(args.text);
    if (long) return err(long);
    const text = clean(args.text);
    if (!text) return err("text is required");
    if (cat(args.category) === "task" || /^TASK:/i.test(text)) {
      return err("Tasks live in the task database, not in memory. Use task_add (and task_list / task_update) instead.");
    }
    const expires = parseExpires(args.expires);
    if (expires === undefined) return err("expires must be a date like 2026-12-18, or left out.");
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory").first();
    if (n >= MAX_FACTS) return err(`Memory is full (${MAX_FACTS} facts). Delete some first.`);
    const dupe = await env.DB.prepare("SELECT * FROM memory WHERE LOWER(text) = LOWER(?)").bind(text).first();
    if (dupe) return ok(`Already saved: ${fmt(dupe)}`);
    const unconfirmed = args.confirmed === false || /^\(unconfirmed\)/i.test(text);
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO memory (id, category, text, status, source, created_at, updated_at, checked_at, expires_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, cat(args.category), text, unconfirmed ? "unconfirmed" : "confirmed", clean(args.source, 20) || "unknown", now, now, now, expires)
      .run();
    return ok(`Saved: ${fmt(await env.DB.prepare("SELECT * FROM memory WHERE id = ?").bind(id).first())}`);
  }

  if (name === "memory_search") {
    const words = clean(args.query, 200).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return err("query is required");
    const category = args.category ? cat(args.category) : null;
    const pool = (await loadFacts(env, category)).filter((f) => category || f.category !== "archive");
    const hits = pool
      .map((f) => [score(f, words), f])
      .filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0] || b[1].updated_at.localeCompare(a[1].updated_at))
      .slice(0, Math.min(Number(args.limit) || 20, 100))
      .map(([, f]) => fmt(f));
    return ok(hits.length ? hits.join("\n") : "No matching facts.");
  }

  if (name === "memory_list") {
    const pool = await loadFacts(env, args.category ? cat(args.category) : null);
    const rows = pool.slice(0, Math.min(Number(args.limit) || 50, 500)).map(fmt);
    return ok(rows.length ? `${pool.length} fact(s):\n${rows.join("\n")}` : "Memory is empty.");
  }

  if (name === "memory_recent") {
    const limit = Math.min(Number(args.limit) || 10, 50);
    const newest = async (table, kind, line) =>
      ((await env.DB.prepare(`SELECT * FROM ${table} ORDER BY updated_at DESC LIMIT ${limit}`).all()).results || []).map((r) => ({
        at: r.updated_at,
        text: `${ago(r.updated_at)}, ${r.created_at === r.updated_at ? "added" : "changed"} ${kind}: ${line(r)}`,
      }));
    const rows = [...(await newest("memory", "memory", fmt)), ...(await newest("tasks", "task", fmtTask)), ...(await newest("bills", "bill", fmtBill))]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit)
      .map((r) => r.text);
    return ok(rows.length ? `Most recent first:\n${rows.join("\n")}` : "Nothing has been saved yet.");
  }

  if (name === "memory_update") {
    const id = clean(args.id, 20);
    const f = await env.DB.prepare("SELECT * FROM memory WHERE id = ?").bind(id).first();
    if (!f) return err("No fact with that id.");
    const sets = ["checked_at = ?"], vals = [now]; // any update counts as "looked at and still true"
    if (args.text != null) {
      const long = tooLong(args.text);
      if (long) return err(long);
      const text = clean(args.text);
      if (!text) return err("text can't be empty. Leave it out to keep the current text.");
      if (text !== f.text) { sets.push("text = ?", "updated_at = ?"); vals.push(text, now); }
    }
    if (args.category) { sets.push("category = ?"); vals.push(cat(args.category)); }
    if (typeof args.confirmed === "boolean") { sets.push("status = ?"); vals.push(args.confirmed ? "confirmed" : "unconfirmed"); }
    if (args.expires != null) {
      const expires = parseExpires(args.expires);
      if (expires === undefined) return err("expires must be a date like 2026-12-18, or 'none' to clear it.");
      sets.push("expires_on = ?"); vals.push(expires);
    }
    if (args.source) { sets.push("source = ?"); vals.push(clean(args.source, 20)); }
    await env.DB.prepare(`UPDATE memory SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
    return ok(`Updated: ${fmt(await env.DB.prepare("SELECT * FROM memory WHERE id = ?").bind(id).first())}`);
  }

  if (name === "memory_delete") {
    const id = clean(args.id, 20);
    const gone = await env.DB.prepare("SELECT * FROM memory WHERE id = ?").bind(id).first();
    if (!gone) return err("No fact with that id.");
    await env.DB.prepare("DELETE FROM memory WHERE id = ?").bind(id).run();
    return ok(`Deleted: ${gone.text}`);
  }

  return null; // unknown tool
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

async function handleRpc(msg, env) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid request");
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const { method, params } = msg;

  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
    return rpcResult(msg.id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
      instructions:
        "The user's shared memory, used by every assistant connected to it. Search it when personal context would help; save durable facts they share; update facts that change. Never store secrets. " +
        "Their to-dos live in a separate task database: use task_list, task_add, task_update and task_get for anything they need to do, not memory_save. " +
        "Bills and statements they owe go in bill_list, bill_add and bill_update. " +
        "When they mention something they just saved or told another chat, call memory_recent first instead of searching. " +
        "If a note titled WORK LOG exists and this session builds or plans one of their projects, read it first (memory_search \"WORK LOG\") for what earlier sessions did and left unfinished, and add your own line the way that note describes when you finish or stop.",
    });
  }
  if (isNotification) return null; // e.g. notifications/initialized
  if (method === "ping") return rpcResult(msg.id, {});
  if (method === "tools/list") return rpcResult(msg.id, { tools: TOOLS });
  if (method === "tools/call") {
    const result = await callTool(params && params.name, params && params.arguments, env);
    if (!result) return rpcError(msg.id, -32602, `Unknown tool: ${params && params.name}`);
    return rpcResult(msg.id, result);
  }
  if (method === "resources/list") return rpcResult(msg.id, { resources: [] });
  if (method === "prompts/list") return rpcResult(msg.id, { prompts: [] });
  return rpcError(msg.id, -32601, `Method not found: ${method}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["mcp", "<key>"]

    if (parts[0] !== "mcp") return new Response("Shared memory server is running.");
    if (!env.MEMORY_KEY || parts[1] !== env.MEMORY_KEY) return new Response("Not found", { status: 404 });

    TZ = env.TIMEZONE || "UTC";

    if (request.method === "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleRpc(m, env)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202 });
    }
    const res = await handleRpc(body, env);
    return res ? json(res) : new Response(null, { status: 202 });
  },
};