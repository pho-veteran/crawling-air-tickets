CREATE TABLE IF NOT EXISTS interactive (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  command TEXT NOT NULL,
  day TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  completed_ms INTEGER,
  refresh_id TEXT,
  loading_status TEXT NOT NULL DEFAULT 'pending',
  loading_message_id INTEGER,
  loading_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS interactive_active ON interactive(bot_id,chat_id,command) WHERE completed_ms IS NULL;
CREATE INDEX IF NOT EXISTS interactive_day ON interactive(day);
CREATE INDEX IF NOT EXISTS telegram_updates_received ON telegram_updates(received_ms);
CREATE INDEX IF NOT EXISTS interactive_refresh ON interactive(refresh_id,completed_ms);
CREATE UNIQUE INDEX IF NOT EXISTS single_refresh ON jobs(kind) WHERE kind='refresh' AND status IN ('pending','running');
CREATE INDEX IF NOT EXISTS jobs_dispatch ON jobs(status,queued_ms,not_before);
CREATE INDEX IF NOT EXISTS outbox_daily_budget ON outbox(kind,created_ms);
