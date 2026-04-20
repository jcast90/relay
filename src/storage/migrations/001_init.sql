-- Three primitives behind HarnessStore: docs (JSONB key-value), logs
-- (BIGSERIAL-ordered append-only), blobs (BYTEA). The (ns, id) composite
-- primary key mirrors the filesystem layout so the contract stays identical
-- across backends.

CREATE TABLE IF NOT EXISTS harness_docs (
  ns TEXT NOT NULL,
  id TEXT NOT NULL,
  doc JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ns, id)
);

-- text_pattern_ops lets LIKE 'prefix%' use this index regardless of the
-- database's default collation.
CREATE INDEX IF NOT EXISTS idx_harness_docs_ns_id_prefix
  ON harness_docs (ns, id text_pattern_ops);

CREATE TABLE IF NOT EXISTS harness_logs (
  ns TEXT NOT NULL,
  id TEXT NOT NULL,
  seq BIGSERIAL NOT NULL,
  entry JSONB NOT NULL,
  entry_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ns, id, seq)
);

CREATE TABLE IF NOT EXISTS harness_blobs (
  ns TEXT NOT NULL,
  id TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  size BIGINT NOT NULL,
  content_type TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ns, id)
);

-- pg_notify from triggers instead of call sites so a future caller that
-- inserts directly (e.g. an admin SQL session) still emits the event and
-- watchers don't silently go stale.
--
-- Channel name cap: Postgres identifiers truncate at 63 bytes. The prefix
-- `harness_change_` is 15 chars, leaving 48 for `ns`. The application layer
-- (`postgres-store.ts` `watch()` guard and `MAX_WATCH_NS_LENGTH`) rejects
-- any `ns` longer than 48 so LISTEN and NOTIFY agree on the same identifier.
CREATE OR REPLACE FUNCTION harness_notify_change() RETURNS TRIGGER AS $$
DECLARE
  change_kind TEXT;
  ns_val TEXT;
  id_val TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    ns_val := OLD.ns; id_val := OLD.id; change_kind := 'delete';
  ELSIF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'harness_logs' THEN
    ns_val := NEW.ns; id_val := NEW.id; change_kind := 'append';
  ELSE
    ns_val := NEW.ns; id_val := NEW.id; change_kind := 'put';
  END IF;
  PERFORM pg_notify(
    'harness_change_' || ns_val,
    json_build_object('id', id_val, 'kind', change_kind)::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS harness_docs_notify ON harness_docs;
CREATE TRIGGER harness_docs_notify
  AFTER INSERT OR UPDATE OR DELETE ON harness_docs
  FOR EACH ROW EXECUTE FUNCTION harness_notify_change();

DROP TRIGGER IF EXISTS harness_logs_notify ON harness_logs;
CREATE TRIGGER harness_logs_notify
  AFTER INSERT ON harness_logs
  FOR EACH ROW EXECUTE FUNCTION harness_notify_change();

DROP TRIGGER IF EXISTS harness_blobs_notify ON harness_blobs;
CREATE TRIGGER harness_blobs_notify
  AFTER INSERT OR UPDATE OR DELETE ON harness_blobs
  FOR EACH ROW EXECUTE FUNCTION harness_notify_change();
