CREATE TABLE studymate.attempts (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    quiz_id UUID NOT NULL,
    operation_key UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
    question_count INTEGER NOT NULL CHECK (question_count = 10),
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    correct_count INTEGER,
    score_percent NUMERIC(5,2),
    UNIQUE (owner_id, operation_key),
    UNIQUE (id, quiz_id),
    FOREIGN KEY (quiz_id, owner_id) REFERENCES studymate.quizzes(id, owner_id) ON DELETE CASCADE,
    CHECK ((status = 'in_progress' AND completed_at IS NULL AND correct_count IS NULL AND score_percent IS NULL)
        OR (status = 'completed' AND completed_at IS NOT NULL AND completed_at >= started_at
            AND correct_count IS NOT NULL AND correct_count BETWEEN 0 AND question_count
            AND score_percent IS NOT NULL AND score_percent = round(100.0 * correct_count / question_count, 2)))
);
CREATE INDEX attempts_owner_history_idx ON studymate.attempts(owner_id, started_at DESC, id DESC);
CREATE INDEX attempts_quiz_idx ON studymate.attempts(quiz_id);

-- Every question has a saved row after submission; NULL means skipped.
CREATE TABLE studymate.attempt_answers (
    attempt_id UUID NOT NULL,
    quiz_id UUID NOT NULL,
    question_id UUID NOT NULL,
    selected_option_id UUID,
    is_correct BOOLEAN NOT NULL,
    PRIMARY KEY (attempt_id, question_id),
    FOREIGN KEY (attempt_id, quiz_id) REFERENCES studymate.attempts(id, quiz_id) ON DELETE CASCADE,
    FOREIGN KEY (question_id, quiz_id) REFERENCES studymate.quiz_questions(id, quiz_id) ON DELETE CASCADE,
    FOREIGN KEY (selected_option_id, question_id) REFERENCES studymate.quiz_options(id, question_id) ON DELETE CASCADE,
    CHECK (selected_option_id IS NOT NULL OR NOT is_correct)
);
CREATE INDEX attempt_answers_question_idx ON studymate.attempt_answers(question_id);
CREATE INDEX attempt_answers_option_idx ON studymate.attempt_answers(selected_option_id, question_id);
