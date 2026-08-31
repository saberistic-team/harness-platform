CREATE TABLE IF NOT EXISTS control_plane_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_tasks (
  task_id TEXT PRIMARY KEY,
  manifest JSONB NOT NULL,
  manifest_digest CHAR(64) NOT NULL,
  admission_key TEXT NOT NULL UNIQUE,
  admitted_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS control_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES control_tasks(task_id),
  manifest_digest CHAR(64) NOT NULL,
  admission_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'leased', 'running', 'passed', 'failed', 'blocked',
    'canceled', 'indeterminate'
  )),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  worker_id TEXT,
  lease_id TEXT,
  fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  completion_key TEXT UNIQUE,
  report_path TEXT,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (
    (status IN ('leased', 'running') AND worker_id IS NOT NULL AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status NOT IN ('leased', 'running') AND worker_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS control_runs_queue_idx
  ON control_runs (priority DESC, queued_at ASC, run_id ASC)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS control_runs_lease_expiry_idx
  ON control_runs (lease_expires_at)
  WHERE status IN ('leased', 'running');

CREATE INDEX IF NOT EXISTS control_runs_task_idx
  ON control_runs (task_id, queued_at DESC, run_id DESC);

CREATE TABLE IF NOT EXISTS control_artifacts (
  artifact_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('run_report', 'output', 'audit')),
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  content_type TEXT NOT NULL,
  task_id TEXT REFERENCES control_tasks(task_id),
  run_id TEXT REFERENCES control_runs(run_id),
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bucket, object_key)
);

CREATE INDEX IF NOT EXISTS control_artifacts_run_idx
  ON control_artifacts (run_id, created_at, artifact_id);

CREATE INDEX IF NOT EXISTS control_artifacts_session_idx
  ON control_artifacts (session_id, created_at, artifact_id);

CREATE TABLE IF NOT EXISTS control_audit_checkpoints (
  session_id TEXT PRIMARY KEY,
  next_seq BIGINT NOT NULL CHECK (next_seq >= -1),
  artifact_id TEXT REFERENCES control_artifacts(artifact_id),
  updated_at TIMESTAMPTZ NOT NULL
);

INSERT INTO control_plane_meta (key, value)
VALUES ('schema_version', '1')
ON CONFLICT (key) DO NOTHING;
