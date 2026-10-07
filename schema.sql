-- Shared Memory tables (Cloudflare D1, which is SQLite).
-- Apply: npx wrangler d1 execute shared-memory --remote --file schema.sql
-- Safe to run again: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS memory (
  id         TEXT PRIMARY KEY,             -- 8 hex chars
  category   TEXT NOT NULL DEFAULT 'other',
  text       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'unconfirmed')),
                                           -- unconfirmed = an assistant's inference, not something the user said
  source     TEXT,                         -- claude, chatgpt
  created_at TEXT NOT NULL,                -- ISO UTC
  updated_at TEXT NOT NULL,                -- ISO UTC, last time the text changed
  checked_at TEXT,                         -- ISO UTC, last time someone confirmed it is still true
  expires_on TEXT                          -- 'YYYY-MM-DD' local; after this day it is flagged as expired
);

CREATE INDEX IF NOT EXISTS idx_memory_category ON memory (category);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,             -- 8 hex chars
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'done', 'dropped')),
  due_at     TEXT,                         -- local time, 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM', NULL = no due date
  next_step  TEXT,
  notes      TEXT,
  source     TEXT,                         -- 'user' (they asked) or 'proactive' (assistant noticed)
  created_at TEXT NOT NULL,                -- ISO UTC
  updated_at TEXT NOT NULL,
  done_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks (status, due_at);

CREATE TABLE IF NOT EXISTS task_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  at      TEXT NOT NULL,                   -- ISO UTC
  by      TEXT,                            -- 'claude', 'chatgpt', ...
  note    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_log_task ON task_log (task_id, at);

CREATE TABLE IF NOT EXISTS bills (
  id         TEXT PRIMARY KEY,             -- 8 hex chars
  name       TEXT NOT NULL,
  amount     REAL,                         -- NULL if unknown
  due_at     TEXT,                         -- 'YYYY-MM-DD', NULL if unknown
  status     TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid', 'skipped')),
  autopay    INTEGER NOT NULL DEFAULT 0,   -- 1 = autopay covers it in full
  notes      TEXT,
  source     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_bills_status_due ON bills (status, due_at);
