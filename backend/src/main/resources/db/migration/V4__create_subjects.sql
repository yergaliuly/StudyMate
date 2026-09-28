CREATE TABLE studymate.subjects (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES studymate.users(id),
    title VARCHAR(60) NOT NULL CHECK (length(btrim(title)) > 0),
    normalized_title TEXT COLLATE "C" NOT NULL CHECK (length(normalized_title) > 0),
    description VARCHAR(160) NOT NULL,
    normalized_description TEXT COLLATE "C" NOT NULL,
    icon VARCHAR(16) NOT NULL CHECK (icon IN ('book', 'database', 'languages', 'code')),
    tone VARCHAR(16) NOT NULL CHECK (tone IN ('blue', 'purple', 'indigo', 'green')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT subjects_owner_title_key UNIQUE (owner_id, normalized_title)
);
CREATE INDEX subjects_owner_created_idx ON studymate.subjects (owner_id, created_at DESC, id DESC);
COMMENT ON COLUMN studymate.subjects.normalized_title IS
    'ECMAScript trim/whitespace collapse then Java lowercase(Locale.ROOT); title preserves display case';
COMMENT ON COLUMN studymate.subjects.normalized_description IS
    'Java lowercase(Locale.ROOT) of trimmed description for locale-independent literal substring search';

-- Only successful POST /api/v1/subjects responses. No FK to the created subject:
-- a replay describes the original creation even when a future deletion removes that subject.
CREATE TABLE studymate.subject_creation_requests (
    owner_id UUID NOT NULL REFERENCES studymate.users(id) ON DELETE CASCADE,
    request_key UUID NOT NULL,
    fingerprint CHAR(64) NOT NULL,
    response_body TEXT NOT NULL,
    response_location TEXT NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '24 hours'),
    PRIMARY KEY (owner_id, request_key),
    CHECK (expires_at > completed_at)
);
CREATE INDEX subject_creation_expiry_idx ON studymate.subject_creation_requests (expires_at);
