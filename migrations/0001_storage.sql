PRAGMA foreign_keys = ON;

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  query_id TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'error')),
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);
CREATE INDEX observations_history ON observations(source, query_id, observed_ms, id);
CREATE INDEX observations_retention ON observations(observed_ms, id);

CREATE TABLE price_quotes (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  basis_source TEXT NOT NULL,
  query_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('roundtrip', 'outbound', 'inbound')),
  departure_date TEXT NOT NULL,
  return_date TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  observed_ms INTEGER NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  PRIMARY KEY (observation_id, kind, departure_date, return_date)
);
CREATE INDEX price_quotes_window ON price_quotes(
  basis_source, query_id, kind, departure_date, return_date, observed_ms
);

-- No FK to observations: pruning raw history must not erase all-time minima.
CREATE TABLE price_minima (
  basis_source TEXT NOT NULL,
  query_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  departure_date TEXT NOT NULL,
  return_date TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  observed_ms INTEGER NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  PRIMARY KEY (basis_source, query_id, kind, departure_date, return_date)
);

CREATE TABLE subscribers (
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (bot_id, chat_id)
);
CREATE INDEX subscribers_active ON subscribers(bot_id, active, chat_id);

-- Preserve cursor, recipient ACKs, cooldown and pending events losslessly.
-- Mapping these documents to the live Worker outbox is a separate cutover gate.
CREATE TABLE legacy_documents (
  namespace TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK (json_valid(document_json))
);

CREATE TABLE leases (
  resource TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
);
