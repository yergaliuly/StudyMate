CREATE TABLE studymate.request_limits (
    bucket varchar(32) NOT NULL,
    subject varchar(64) NOT NULL,
    used integer NOT NULL CHECK (used > 0),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (bucket, subject)
);
CREATE INDEX request_limits_expiry ON studymate.request_limits(expires_at);
