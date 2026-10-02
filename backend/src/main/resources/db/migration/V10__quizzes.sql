ALTER TABLE studymate.materials ADD COLUMN quiz_job_id UUID REFERENCES studymate.jobs(id);
ALTER TABLE studymate.materials ADD CONSTRAINT materials_id_owner_key UNIQUE (id, owner_id);

CREATE TABLE studymate.quizzes (
    id UUID PRIMARY KEY,
    material_id UUID NOT NULL,
    owner_id UUID NOT NULL,
    version BIGINT NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    generation_job_id UUID NOT NULL UNIQUE REFERENCES studymate.jobs(id),
    question_count INTEGER NOT NULL CHECK (question_count = 10),
    model VARCHAR(80) NOT NULL,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (material_id, version),
    UNIQUE (id, owner_id),
    FOREIGN KEY (material_id, owner_id) REFERENCES studymate.materials(id, owner_id) ON DELETE CASCADE
);

CREATE TABLE studymate.quiz_questions (
    id UUID PRIMARY KEY,
    quiz_id UUID NOT NULL REFERENCES studymate.quizzes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
    text_content TEXT NOT NULL CHECK (length(text_content) BETWEEN 1 AND 1000),
    correct_option_id UUID NOT NULL,
    explanation TEXT NOT NULL CHECK (length(explanation) BETWEEN 1 AND 2000),
    source_pages JSONB NOT NULL CHECK (jsonb_typeof(source_pages) = 'array' AND jsonb_array_length(source_pages) BETWEEN 1 AND 8),
    UNIQUE (quiz_id, position),
    UNIQUE (id, quiz_id)
);

CREATE TABLE studymate.quiz_options (
    id UUID PRIMARY KEY,
    question_id UUID NOT NULL REFERENCES studymate.quiz_questions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
    text_content TEXT NOT NULL CHECK (length(text_content) BETWEEN 1 AND 500),
    UNIQUE (question_id, position),
    UNIQUE (id, question_id)
);

-- The required answer must reference an option of this exact question. The cycle is checked at commit.
ALTER TABLE studymate.quiz_questions ADD CONSTRAINT quiz_correct_option_fk
    FOREIGN KEY (correct_option_id, id) REFERENCES studymate.quiz_options(id, question_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE studymate.jobs DROP CONSTRAINT jobs_error_code_check;
ALTER TABLE studymate.jobs ADD CONSTRAINT jobs_error_code_check CHECK (error_code IN (
    'JOB_TEMPORARY_FAILURE','JOB_PROCESSING_FAILED','JOB_ATTEMPTS_EXHAUSTED','JOB_LEASE_EXPIRED','JOB_OUTCOME_UNKNOWN',
    'PDF_INVALID','PDF_ENCRYPTED','PDF_NO_TEXT','PDF_TOO_MANY_PAGES','PDF_TEXT_LIMIT',
    'PDF_TIMEOUT','PDF_RESOURCE_LIMIT','PDF_WORKER_FAILED','PDF_ORIGINAL_MISMATCH',
    'AI_UNAVAILABLE','AI_INVALID_RESPONSE','AI_OUTCOME_UNKNOWN','QUIZ_INSUFFICIENT_CONTENT'));
