ALTER TABLE studymate.subjects
    ADD COLUMN version BIGINT NOT NULL DEFAULT 1,
    ADD CONSTRAINT subjects_version_positive CHECK (version > 0);
