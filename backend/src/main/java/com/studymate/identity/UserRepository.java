package com.studymate.identity;

import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class UserRepository {
  private final JdbcClient jdbc;

  UserRepository(JdbcClient jdbc) { this.jdbc = jdbc; }

  record Credentials(UUID id, String passwordHash) {
    @Override public String toString() { return "Credentials[redacted]"; }
  }

  Optional<Credentials> credentials(String normalizedEmail) {
    return jdbc.sql("SELECT id, password_hash FROM studymate.users WHERE normalized_email = :email")
        .param("email", normalizedEmail)
        .query((row, number) -> new Credentials(row.getObject("id", UUID.class), row.getString("password_hash")))
        .optional();
  }

  Optional<User> findById(UUID id) {
    return jdbc.sql("SELECT id, normalized_email, display_name FROM studymate.users WHERE id = :id")
        .param("id", id)
        .query((row, number) -> new User(row.getObject("id", UUID.class),
            row.getString("normalized_email"), row.getString("display_name")))
        .optional();
  }

  Optional<User> create(UUID id, String normalizedEmail, String displayName, String passwordHash) {
    // The named unique constraint arbitrates races; unrelated DB errors are not email conflicts.
    return jdbc.sql("""
        INSERT INTO studymate.users (id, normalized_email, display_name, password_hash)
        VALUES (:id, :email, :displayName, :passwordHash)
        ON CONFLICT ON CONSTRAINT users_normalized_email_key DO NOTHING
        RETURNING id, normalized_email, display_name
        """)
        .param("id", id).param("email", normalizedEmail)
        .param("displayName", displayName).param("passwordHash", passwordHash)
        .query((row, rowNumber) -> new User(row.getObject("id", UUID.class),
            row.getString("normalized_email"), row.getString("display_name")))
        .optional();
  }
}
