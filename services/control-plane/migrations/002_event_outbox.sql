CREATE TABLE IF NOT EXISTS control_event_outbox_sequence (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  next_sequence BIGINT NOT NULL CHECK (next_sequence > 0)
);

INSERT INTO control_event_outbox_sequence (singleton, next_sequence)
VALUES (TRUE, 1)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_event_outbox (
  sequence BIGINT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  publisher_id TEXT,
  claim_expires_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  published_at TIMESTAMPTZ,
  last_error TEXT,
  CHECK (
    (publisher_id IS NULL AND claim_expires_at IS NULL)
    OR
    (publisher_id IS NOT NULL AND claim_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS control_event_outbox_pending_idx
  ON control_event_outbox (sequence)
  WHERE published_at IS NULL;

CREATE OR REPLACE FUNCTION control_artifacts_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $immutable_artifact$
BEGIN
  RAISE EXCEPTION 'control_artifacts rows are immutable'
    USING ERRCODE = '55000';
END;
$immutable_artifact$;

DROP TRIGGER IF EXISTS control_artifacts_immutable ON control_artifacts;
CREATE TRIGGER control_artifacts_immutable
BEFORE UPDATE OR DELETE ON control_artifacts
FOR EACH ROW EXECUTE FUNCTION control_artifacts_reject_mutation();

INSERT INTO control_plane_meta (key, value)
VALUES ('schema_version', '2')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
