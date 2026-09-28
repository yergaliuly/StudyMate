package com.studymate.jobs;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Collection;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.json.JsonMapper;

@Repository
class JobRepository {
  private final JdbcClient jdbc;
  private final JsonMapper mapper;
  JobRepository(JdbcClient jdbc, JsonMapper mapper) { this.jdbc = jdbc; this.mapper = mapper; }

  Optional<UUID> insert(UUID owner, String kind, UUID key, String payload, RetryPolicy policy, JobProperties settings) {
    return jdbc.sql("""
        INSERT INTO studymate.jobs (id, owner_id, kind, operation_key, payload, retry_policy,
            max_attempts, retry_delay_seconds, max_retry_delay_seconds, lease_seconds, execution_timeout_seconds)
        VALUES (:id, :owner, :kind, :key, CAST(:payload AS jsonb), :policy, :attempts, :delay, :maxDelay, :lease, :timeout)
        ON CONFLICT ON CONSTRAINT jobs_operation_key DO NOTHING RETURNING id
        """)
        .param("id", UUID.randomUUID()).param("owner", owner).param("kind", kind).param("key", key)
        .param("payload", payload).param("policy", policy.name())
        .param("attempts", policy == RetryPolicy.MANUAL ? 1 : settings.maxAttempts())
        .param("delay", settings.retryDelaySeconds()).param("maxDelay", settings.maxRetryDelaySeconds())
        .param("lease", settings.leaseSeconds()).param("timeout", settings.executionTimeoutSeconds())
        .query(UUID.class).optional();
  }

  Existing existing(UUID owner, String kind, UUID key, String payload, RetryPolicy policy) {
    return jdbc.sql("""
        SELECT id, payload = CAST(:payload AS jsonb) AND retry_policy = :policy AS matches
        FROM studymate.jobs WHERE owner_id = :owner AND kind = :kind AND operation_key = :key
        """).param("owner", owner).param("kind", kind).param("key", key).param("payload", payload).param("policy", policy.name())
        .query((row, number) -> new Existing(row.getObject("id", UUID.class), row.getBoolean("matches"))).single();
  }
  record Existing(UUID id, boolean matches) {}

  Optional<JobResponse> find(UUID owner, UUID id) {
    return jdbc.sql("SELECT * FROM studymate.jobs WHERE owner_id = :owner AND id = :id")
        .param("owner", owner).param("id", id).query((row, number) -> response(row)).optional();
  }

  Optional<JobLease> claim(Collection<String> kinds) {
    if (kinds.isEmpty()) return Optional.empty();
    return jdbc.sql("""
        WITH candidate AS (
          SELECT id FROM studymate.jobs WHERE status = 'queued' AND next_attempt_at <= clock_timestamp()
            AND attempt_count < max_attempts AND kind IN (:kinds)
          ORDER BY next_attempt_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE studymate.jobs j SET status = 'running', attempt_count = attempt_count + 1,
          lease_token = :token, lease_expires_at = clock_timestamp() + lease_seconds * interval '1 second',
          execution_deadline_at = clock_timestamp() + execution_timeout_seconds * interval '1 second',
          next_attempt_at = NULL, error_code = NULL, updated_at = clock_timestamp()
        FROM candidate c WHERE j.id = c.id RETURNING j.*
        """).param("kinds", kinds).param("token", UUID.randomUUID())
        .query((row, number) -> new JobLease(row.getObject("id", UUID.class), row.getObject("owner_id", UUID.class),
            row.getString("kind"), mapper.readTree(row.getString("payload")), row.getObject("lease_token", UUID.class),
            row.getInt("attempt_count"), RetryPolicy.valueOf(row.getString("retry_policy")), row.getInt("lease_seconds"))).optional();
  }

  boolean renew(JobLease lease) {
    return fenced("""
        UPDATE studymate.jobs SET lease_expires_at = LEAST(execution_deadline_at,
          clock_timestamp() + lease_seconds * interval '1 second'), updated_at = clock_timestamp()
        """, lease).update() == 1;
  }

  boolean lock(JobLease lease) {
    return jdbc.sql("SELECT id FROM studymate.jobs" + fence() + " FOR UPDATE")
        .param("id", lease.id()).param("owner", lease.ownerId()).param("token", lease.token())
        .query(UUID.class).optional().isPresent();
  }

  boolean succeed(JobLease lease, UUID resultId) {
    return fenced("""
        UPDATE studymate.jobs SET status = 'succeeded', result_id = :result,
          lease_token = NULL, lease_expires_at = NULL, execution_deadline_at = NULL,
          updated_at = clock_timestamp(), finished_at = clock_timestamp()
        """, lease).param("result", resultId).update() == 1;
  }

  boolean fail(JobLease lease, JobError error, boolean retry) {
    // Stored settings and attempt count survive restarts/configuration changes.
    return jdbc.sql("""
        UPDATE studymate.jobs SET
          status = CASE WHEN :retry AND retry_policy = 'SAFE' AND attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
          next_attempt_at = CASE WHEN :retry AND retry_policy = 'SAFE' AND attempt_count < max_attempts THEN
            clock_timestamp() + LEAST(max_retry_delay_seconds, retry_delay_seconds * power(2, attempt_count - 1)) * interval '1 second' END,
          finished_at = CASE WHEN NOT (:retry AND retry_policy = 'SAFE' AND attempt_count < max_attempts) THEN clock_timestamp() END,
          error_code = CASE WHEN :retry AND retry_policy = 'SAFE' AND attempt_count >= max_attempts THEN 'JOB_ATTEMPTS_EXHAUSTED' ELSE :error END,
          lease_token = NULL, lease_expires_at = NULL, execution_deadline_at = NULL, updated_at = clock_timestamp()
        """ + fence())
        .param("id", lease.id()).param("owner", lease.ownerId()).param("token", lease.token())
        .param("retry", retry).param("error", error.name()).update() == 1;
  }

  int recoverExpired() {
    return jdbc.sql("""
        WITH expired AS (
          SELECT id FROM studymate.jobs WHERE status = 'running'
            AND (lease_expires_at <= clock_timestamp() OR execution_deadline_at <= clock_timestamp())
          ORDER BY lease_expires_at, id FOR UPDATE SKIP LOCKED LIMIT 100
        )
        UPDATE studymate.jobs j SET
          status = CASE WHEN retry_policy = 'SAFE' AND attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
          next_attempt_at = CASE WHEN retry_policy = 'SAFE' AND attempt_count < max_attempts THEN
            clock_timestamp() + LEAST(max_retry_delay_seconds, retry_delay_seconds * power(2, attempt_count - 1)) * interval '1 second' END,
          finished_at = CASE WHEN NOT (retry_policy = 'SAFE' AND attempt_count < max_attempts) THEN clock_timestamp() END,
          error_code = CASE WHEN retry_policy = 'MANUAL' THEN 'JOB_OUTCOME_UNKNOWN'
            WHEN attempt_count >= max_attempts THEN 'JOB_ATTEMPTS_EXHAUSTED' ELSE 'JOB_LEASE_EXPIRED' END,
          lease_token = NULL, lease_expires_at = NULL, execution_deadline_at = NULL, updated_at = clock_timestamp()
        FROM expired e WHERE j.id = e.id
        """).update();
  }

  boolean cancel(UUID owner, UUID id) {
    return jdbc.sql("""
        UPDATE studymate.jobs SET status = 'cancelled', next_attempt_at = NULL,
          lease_token = NULL, lease_expires_at = NULL, execution_deadline_at = NULL,
          error_code = NULL, finished_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE owner_id = :owner AND id = :id AND status IN ('queued', 'running')
        """).param("owner", owner).param("id", id).update() == 1;
  }

  private JdbcClient.StatementSpec fenced(String sql, JobLease lease) {
    return jdbc.sql(sql + fence()).param("id", lease.id()).param("owner", lease.ownerId()).param("token", lease.token());
  }

  private static String fence() {
    return """
         WHERE id = :id AND owner_id = :owner AND status = 'running' AND lease_token = :token
           AND lease_expires_at > clock_timestamp() AND execution_deadline_at > clock_timestamp()
        """;
  }

  private static JobResponse response(ResultSet row) throws SQLException {
    String status = row.getString("status");
    JobError error = status.equals("failed") ? JobError.valueOf(row.getString("error_code")) : null;
    return new JobResponse(row.getObject("id", UUID.class), row.getString("kind"), status,
        row.getInt("attempt_count"), row.getInt("max_attempts"), instant(row, "created_at"), instant(row, "updated_at"),
        instant(row, "next_attempt_at"), instant(row, "finished_at"), row.getObject("result_id", UUID.class),
        error == null ? null : new JobResponse.Error(error.name(), error.message()));
  }

  private static Instant instant(ResultSet row, String column) throws SQLException {
    var time = row.getTimestamp(column);
    return time == null ? null : time.toInstant();
  }
}
