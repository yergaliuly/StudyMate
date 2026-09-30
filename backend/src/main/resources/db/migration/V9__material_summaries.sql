ALTER TABLE studymate.materials
    ADD COLUMN summary_job_id UUID REFERENCES studymate.jobs(id);

CREATE TABLE studymate.material_summaries (
    material_id UUID PRIMARY KEY REFERENCES studymate.materials(id) ON DELETE CASCADE,
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE studymate.summary_versions (
    material_id UUID NOT NULL REFERENCES studymate.material_summaries(material_id) ON DELETE CASCADE,
    version BIGINT NOT NULL CHECK (version > 0),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 100000),
    source_pages JSONB NOT NULL CHECK (jsonb_typeof(source_pages) = 'array'),
    origin VARCHAR(8) NOT NULL CHECK (origin IN ('ai', 'user')),
    model VARCHAR(80),
    input_tokens INTEGER CHECK (input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (material_id, version),
    CHECK ((origin = 'ai') = (model IS NOT NULL))
);

ALTER TABLE studymate.jobs DROP CONSTRAINT jobs_error_code_check;
ALTER TABLE studymate.jobs ADD CONSTRAINT jobs_error_code_check CHECK (error_code IN (
    'JOB_TEMPORARY_FAILURE','JOB_PROCESSING_FAILED','JOB_ATTEMPTS_EXHAUSTED','JOB_LEASE_EXPIRED','JOB_OUTCOME_UNKNOWN',
    'PDF_INVALID','PDF_ENCRYPTED','PDF_NO_TEXT','PDF_TOO_MANY_PAGES','PDF_TEXT_LIMIT',
    'PDF_TIMEOUT','PDF_RESOURCE_LIMIT','PDF_WORKER_FAILED','PDF_ORIGINAL_MISMATCH',
    'AI_UNAVAILABLE','AI_INVALID_RESPONSE','AI_OUTCOME_UNKNOWN'));
