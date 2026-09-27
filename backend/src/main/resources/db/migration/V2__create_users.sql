CREATE TABLE studymate.users (
  id uuid PRIMARY KEY,
  normalized_email varchar(254) COLLATE "C" NOT NULL,
  display_name varchar(60) NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_normalized_email_key UNIQUE (normalized_email),
  CONSTRAINT users_email_not_blank CHECK (length(btrim(normalized_email)) > 0),
  CONSTRAINT users_display_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT users_password_hash_not_blank CHECK (length(password_hash) > 0)
);

COMMENT ON COLUMN studymate.users.normalized_email IS
  'Canonical email: ECMAScript trim followed by Java lowercase(Locale.ROOT); no provider-specific rewrites';
COMMENT ON COLUMN studymate.users.password_hash IS
  'Versioned one-way password hash; never a plaintext password';
