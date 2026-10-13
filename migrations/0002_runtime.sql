CREATE TABLE runtime_state (
  key TEXT PRIMARY KEY,
  document_json TEXT NOT NULL CHECK(json_valid(document_json))
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER NOT NULL DEFAULT 0,
  queued_ms INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  done_ms INTEGER
);
CREATE INDEX jobs_due ON jobs(status,not_before,created_ms);
CREATE TABLE telegram_updates (
  bot_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  received_ms INTEGER NOT NULL,
  PRIMARY KEY(bot_id,update_id)
);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  guards_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(guards_json)),
  state_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','discarded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  message_id INTEGER
);
CREATE INDEX outbox_pending ON outbox(status,not_before);
ALTER TABLE subscribers ADD COLUMN last_update_id INTEGER NOT NULL DEFAULT -1;
