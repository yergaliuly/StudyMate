package com.studymate.identity;

import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class UserRepository {
  private final JdbcClient jdbc;

  UserRepository(JdbcClient jdbc) { this.jdbc = jdbc; }

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
