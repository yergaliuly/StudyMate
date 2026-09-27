package com.studymate.subjects;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class SubjectCreationRequests {
  private final JdbcClient jdbc;
  SubjectCreationRequests(JdbcClient jdbc) { this.jdbc = jdbc; }

  record Saved(String fingerprint, SubjectCreation result) {}

  static long lockKey(UUID owner, UUID key) {
    return ByteBuffer.wrap(digest(("POST /api/v1/subjects:" + owner + ":" + key).getBytes(StandardCharsets.UTF_8))).getLong();
  }

  static String fingerprint(byte[] normalizedFields) { return HexFormat.of().formatHex(digest(normalizedFields)); }

  private static byte[] digest(byte[] value) {
    try { return MessageDigest.getInstance("SHA-256").digest(value); }
    catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("SHA-256 unavailable", impossible); }
  }

  boolean tryLock(UUID owner, UUID key) {
    return jdbc.sql("SELECT pg_try_advisory_xact_lock(:key)").param("key", lockKey(owner, key)).query(Boolean.class).single();
  }

  Optional<Saved> find(UUID owner, UUID key) {
    return jdbc.sql("""
        SELECT fingerprint, response_body, response_location FROM studymate.subject_creation_requests
        WHERE owner_id = :owner AND request_key = :key AND expires_at > clock_timestamp()
        """).param("owner", owner).param("key", key)
        .query((row, number) -> new Saved(row.getString("fingerprint"),
            new SubjectCreation(row.getString("response_body"), row.getString("response_location")))).optional();
  }

  void save(UUID owner, UUID key, String fingerprint, SubjectCreation result) {
    jdbc.sql("DELETE FROM studymate.subject_creation_requests WHERE owner_id = :owner AND request_key = :key AND expires_at <= clock_timestamp()")
        .param("owner", owner).param("key", key).update();
    jdbc.sql("""
        INSERT INTO studymate.subject_creation_requests (owner_id, request_key, fingerprint, response_body, response_location)
        VALUES (:owner, :key, :fingerprint, :body, :location)
        """).param("owner", owner).param("key", key).param("fingerprint", fingerprint)
        .param("body", result.body()).param("location", result.location()).update();
  }

  int deleteExpired() {
    return jdbc.sql("""
        WITH expired AS (
          SELECT owner_id, request_key FROM studymate.subject_creation_requests
          WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
        )
        DELETE FROM studymate.subject_creation_requests r USING expired e
        WHERE r.owner_id = e.owner_id AND r.request_key = e.request_key
        """).update();
  }
}
