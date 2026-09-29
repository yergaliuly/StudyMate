ALTER TABLE studymate.materials
    ADD COLUMN processing_job_id UUID REFERENCES studymate.jobs(id),
    ADD COLUMN page_count INTEGER CHECK (page_count BETWEEN 1 AND 200),
    ADD COLUMN text_characters INTEGER CHECK (text_characters BETWEEN 1 AND 1000000);
ALTER TABLE studymate.materials ADD CONSTRAINT materials_text_result_check
    CHECK ((page_count IS NULL) = (text_characters IS NULL));

CREATE TABLE studymate.material_pages (
    material_id UUID NOT NULL REFERENCES studymate.materials(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL CHECK (page_number BETWEEN 1 AND 200),
    text_content TEXT NOT NULL CHECK (length(text_content) <= 100000),
    PRIMARY KEY(material_id,page_number)
);

ALTER TABLE studymate.jobs DROP CONSTRAINT jobs_error_code_check;
ALTER TABLE studymate.jobs ADD CONSTRAINT jobs_error_code_check CHECK (error_code IN (
    'JOB_TEMPORARY_FAILURE','JOB_PROCESSING_FAILED','JOB_ATTEMPTS_EXHAUSTED','JOB_LEASE_EXPIRED','JOB_OUTCOME_UNKNOWN',
    'PDF_INVALID','PDF_ENCRYPTED','PDF_NO_TEXT','PDF_TOO_MANY_PAGES','PDF_TEXT_LIMIT',
    'PDF_TIMEOUT','PDF_RESOURCE_LIMIT','PDF_WORKER_FAILED','PDF_ORIGINAL_MISMATCH'));
-- Existing materials deliberately remain not_started. No remote work or cache rewriting in a migration.
