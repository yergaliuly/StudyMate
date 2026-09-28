CREATE TABLE studymate.jobs (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES studymate.users(id),
    kind VARCHAR(80) NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{0,79}$'),
    operation_key UUID NOT NULL,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    retry_policy VARCHAR(16) NOT NULL CHECK (retry_policy IN ('SAFE', 'MANUAL')),
    status VARCHAR(16) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
    retry_delay_seconds INTEGER NOT NULL CHECK (retry_delay_seconds BETWEEN 1 AND 3600),
    max_retry_delay_seconds INTEGER NOT NULL CHECK (max_retry_delay_seconds BETWEEN retry_delay_seconds AND 3600),
    lease_seconds INTEGER NOT NULL CHECK (lease_seconds BETWEEN 1 AND 300),
    execution_timeout_seconds INTEGER NOT NULL CHECK (execution_timeout_seconds BETWEEN lease_seconds AND 3600),
    next_attempt_at TIMESTAMPTZ DEFAULT clock_timestamp(),
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    execution_deadline_at TIMESTAMPTZ,
    result_id UUID,
    error_code VARCHAR(48) CHECK (error_code IN ('JOB_TEMPORARY_FAILURE', 'JOB_PROCESSING_FAILED',
        'JOB_ATTEMPTS_EXHAUSTED', 'JOB_LEASE_EXPIRED', 'JOB_OUTCOME_UNKNOWN')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT jobs_operation_key UNIQUE (owner_id, kind, operation_key),
    CHECK (attempt_count BETWEEN 0 AND max_attempts),
    CHECK ((status = 'queued' AND next_attempt_at IS NOT NULL) OR (status <> 'queued' AND next_attempt_at IS NULL)),
    CHECK ((status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND execution_deadline_at IS NOT NULL)
        OR (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL AND execution_deadline_at IS NULL)),
    CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
    CHECK (status = 'succeeded' OR result_id IS NULL),
    CHECK (status <> 'failed' OR error_code IS NOT NULL),
    CHECK (status NOT IN ('running', 'succeeded', 'cancelled') OR error_code IS NULL)
);

CREATE INDEX jobs_ready_idx ON studymate.jobs (next_attempt_at, created_at, id) WHERE status = 'queued';
CREATE INDEX jobs_expired_idx ON studymate.jobs (lease_expires_at, id) WHERE status = 'running';
CREATE INDEX jobs_owner_idx ON studymate.jobs (owner_id, created_at DESC, id);
