-- The ledger survives deletion: a late/ambiguous PUT must never lose its object key.
CREATE TABLE studymate.material_objects (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES studymate.users(id),
    request_key UUID NOT NULL,
    fingerprint CHAR(64) NOT NULL,
    object_key VARCHAR(160) NOT NULL UNIQUE,
    size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
    sha256 CHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','stored','deleting','deleted')),
    accounting VARCHAR(8) NOT NULL DEFAULT 'reserved' CHECK (accounting IN ('reserved','used','released')),
    upload_expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '5 minutes'),
    cleanup_not_before TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '5 minutes'),
    cleanup_job_id UUID REFERENCES studymate.jobs(id),
    response_body TEXT,
    audit_after TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(owner_id, request_key),
    UNIQUE(id, owner_id),
    CHECK ((state = 'deleted') = (accounting = 'released')),
    CHECK (state <> 'uploading' OR accounting = 'reserved'),
    CHECK (state <> 'stored' OR (accounting = 'used' AND response_body IS NOT NULL)),
    CHECK (state NOT IN ('deleting','deleted') OR cleanup_job_id IS NOT NULL)
);
CREATE INDEX material_objects_quota_idx ON studymate.material_objects(owner_id) WHERE accounting <> 'released';
CREATE INDEX material_objects_upload_expiry_idx ON studymate.material_objects(upload_expires_at, id) WHERE state = 'uploading';
CREATE INDEX material_objects_audit_idx ON studymate.material_objects(audit_after, id) WHERE state = 'deleted';

ALTER TABLE studymate.subjects ADD CONSTRAINT subjects_id_owner_key UNIQUE(id, owner_id);
CREATE TABLE studymate.materials (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    subject_id UUID NOT NULL,
    title VARCHAR(160) NOT NULL CHECK (length(title) > 0),
    normalized_title TEXT COLLATE "C" NOT NULL,
    file_name VARCHAR(180) NOT NULL,
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (id, owner_id) REFERENCES studymate.material_objects(id, owner_id),
    FOREIGN KEY (subject_id, owner_id) REFERENCES studymate.subjects(id, owner_id) ON DELETE RESTRICT NOT DEFERRABLE
);
CREATE INDEX materials_subject_idx ON studymate.materials(subject_id);
CREATE INDEX materials_owner_page_idx ON studymate.materials(owner_id, created_at DESC, id DESC);
-- Future pages/summaries/quizzes/attempts must reference materials with ON DELETE CASCADE.
-- No learning data is created by this migration.
