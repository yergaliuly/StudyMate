package com.studymate.jobs;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.studymate.PostgresIntegrationTest;
import com.studymate.common.api.ApiException;
import com.studymate.identity.AuthHttpClient;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "studymate.registration.enabled=true")
@ActiveProfiles("local")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JobsIT extends PostgresIntegrationTest {
  @Value("${local.server.port}") int port;
  @Autowired JobQueue queue;
  @Autowired JobRepository jobs;
  @Autowired JobCompletion completion;
  @Autowired JdbcTemplate jdbc;
  @Autowired DataSource dataSource;
  @Autowired JsonMapper mapper;
  @Autowired PlatformTransactionManager transactions;

  @BeforeAll void setup() {
    jdbc.execute("CREATE TABLE studymate.stage7_job_effects_test (job_id UUID PRIMARY KEY, result_id UUID NOT NULL)");
  }
  @AfterAll void cleanup() { jdbc.execute("DROP TABLE studymate.stage7_job_effects_test"); }

  @Test void enqueueIsDurableDeduplicatesJsonObjectsAndSeparatesOwnersAndKinds() {
    UUID owner = owner(); UUID key = UUID.randomUUID(); String kind = kind();
    UUID id = queue.enqueue(owner, kind, key, json("{\"a\":1,\"nested\":{\"x\":true,\"y\":false}}"), RetryPolicy.SAFE);
    assertThat(queue.enqueue(owner, kind, key, json("{\"nested\":{\"y\":false,\"x\":true},\"a\":1}"), RetryPolicy.SAFE)).isEqualTo(id);
    assertThat(queue.get(owner, id).status()).isEqualTo("queued");
    assertThat(queue.get(owner, id).attemptCount()).isZero();
    assertThat(queue.get(owner, id).nextAttemptAt()).isNotNull();
    assertThatThrownBy(() -> queue.enqueue(owner, kind, key, json("{\"a\":2}"), RetryPolicy.SAFE)).isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> queue.enqueue(owner, kind, key, json("{\"a\":1,\"nested\":{\"x\":true,\"y\":false}}"), RetryPolicy.MANUAL)).isInstanceOf(ApiException.class);
    UUID otherOwnerJob = queue.enqueue(owner(), kind, key, json("{}"), RetryPolicy.SAFE);
    assertThat(otherOwnerJob).isNotEqualTo(id);
    assertThat(queue.enqueue(owner, kind(), key, json("{}"), RetryPolicy.SAFE)).isNotEqualTo(id);
    var lease = claim(kind);
    assertThat(completion.finish(lease, new JobOutcome.Succeeded(() -> null))).isTrue();
    assertThat(queue.enqueue(owner, kind, key, json("{\"a\":1,\"nested\":{\"x\":true,\"y\":false}}"), RetryPolicy.SAFE)).isEqualTo(id);
    assertThat(queue.get(owner, id).status()).isEqualTo("succeeded");
    assertThat(claim(kind).id()).isEqualTo(otherOwnerJob);
    assertThat(jobs.claim(List.of(kind))).isEmpty();
  }

  @Test void concurrentEnqueueCreatesExactlyOneJob() throws Exception {
    UUID owner = owner(); UUID key = UUID.randomUUID(); String kind = kind();
    try (var executor = Executors.newFixedThreadPool(2)) {
      var barrier = new CyclicBarrier(2);
      var a = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return queue.enqueue(owner, kind, key, json("{}"), RetryPolicy.SAFE); });
      var b = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return queue.enqueue(owner, kind, key, json("{}"), RetryPolicy.SAFE); });
      assertThat(a.get(15, TimeUnit.SECONDS)).isEqualTo(b.get(15, TimeUnit.SECONDS));
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.jobs WHERE owner_id = ? AND kind = ?", Integer.class, owner, kind)).isEqualTo(1);
    }
  }

  @Test void enqueueAndCancellationJoinTheDomainTransaction() {
    UUID owner = owner(); String kind = kind(); UUID key = UUID.randomUUID();
    var tx = new TransactionTemplate(transactions);
    assertThatThrownBy(() -> tx.executeWithoutResult(status -> {
      UUID id = queue.enqueue(owner, kind, key, json("{}"), RetryPolicy.SAFE);
      jdbc.update("INSERT INTO studymate.stage7_job_effects_test VALUES (?, ?)", id, UUID.randomUUID());
      throw new IllegalStateException("simulated domain rollback");
    })).isInstanceOf(IllegalStateException.class);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.jobs WHERE owner_id = ? AND kind = ?", Integer.class, owner, kind)).isZero();
    UUID id = queue.enqueue(owner, kind, key, json("{}"), RetryPolicy.SAFE);
    tx.executeWithoutResult(status -> { assertThat(queue.cancel(owner, id)).isTrue(); status.setRollbackOnly(); });
    assertThat(queue.get(owner, id).status()).isEqualTo("queued");
  }

  @Test void claimsAreExclusiveAndSkipRowsLockedByAnotherTransaction() throws Exception {
    UUID owner = owner(); String kind = kind(); UUID first = enqueue(owner, kind, RetryPolicy.SAFE);
    UUID second = enqueue(owner, kind, RetryPolicy.SAFE);
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (var lock = connection.prepareStatement("SELECT id FROM studymate.jobs WHERE id = ? FOR UPDATE")) {
        lock.setObject(1, first); lock.executeQuery().close();
        assertThat(claim(kind).id()).isEqualTo(second);
      } finally { connection.rollback(); }
    }
    try (var executor = Executors.newFixedThreadPool(2)) {
      var barrier = new CyclicBarrier(2);
      var a = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return jobs.claim(List.of(kind)); });
      var b = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return jobs.claim(List.of(kind)); });
      var claimed = List.of(a.get(10, TimeUnit.SECONDS), b.get(10, TimeUnit.SECONDS));
      assertThat(claimed.stream().filter(java.util.Optional::isPresent).count()).isEqualTo(1);
      assertThat(claimed.stream().flatMap(java.util.Optional::stream).findFirst().orElseThrow().id()).isEqualTo(first);
    }
  }

  @Test void dueTimeAndSupportedKindsAreRespected() {
    UUID owner = owner(); String kind = kind(); UUID id = enqueue(owner, kind, RetryPolicy.SAFE);
    jdbc.update("UPDATE studymate.jobs SET next_attempt_at = clock_timestamp() + interval '1 hour' WHERE id = ?", id);
    assertThat(jobs.claim(List.of(kind))).isEmpty();
    due(id);
    assertThat(jobs.claim(List.of(kind()))).isEmpty();
    assertThat(jobs.claim(List.of())).isEmpty();
    assertThat(queue.get(owner, id).attemptCount()).isZero();
    assertThat(claim(kind).attemptCount()).isEqualTo(1);
  }

  @Test void renewableLeaseHasAFixedDeadlineAndCannotBeRevivedAfterExpiry() {
    UUID owner = owner(); String kind = kind(); UUID id = enqueue(owner, kind, RetryPolicy.SAFE);
    var lease = claim(kind);
    jdbc.update("UPDATE studymate.jobs SET lease_expires_at = clock_timestamp() + interval '1 second', execution_deadline_at = clock_timestamp() + interval '5 seconds' WHERE id = ?", id);
    assertThat(jobs.renew(lease)).isTrue();
    assertThat(jdbc.queryForObject("SELECT lease_expires_at = execution_deadline_at FROM studymate.jobs WHERE id = ?", Boolean.class, id)).isTrue();
    expire(id);
    assertThat(jobs.renew(lease)).isFalse();
    var called = new AtomicBoolean();
    assertThat(completion.finish(lease, new JobOutcome.Succeeded(() -> { called.set(true); return null; }))).isFalse();
    assertThat(called).isFalse();
  }

  @Test void retryHasBackoffACapAndABoundedNumberOfAttempts() {
    UUID owner = owner(); String kind = kind(); UUID id = enqueue(owner, kind, RetryPolicy.SAFE);
    jdbc.update("UPDATE studymate.jobs SET max_retry_delay_seconds = 3 WHERE id = ?", id);
    for (int attempt = 1; attempt <= 3; attempt++) {
      var lease = claim(kind);
      assertThat(lease.attemptCount()).isEqualTo(attempt);
      // Scheduling uses the database clock; JVM/OS clocks can differ at sub-millisecond precision.
      Instant before = jdbc.queryForObject("SELECT clock_timestamp()", java.sql.Timestamp.class).toInstant();
      assertThat(completion.finish(lease, new JobOutcome.Retry(JobError.JOB_TEMPORARY_FAILURE))).isTrue();
      var response = queue.get(owner, id);
      if (attempt < 3) {
        assertThat(response.status()).isEqualTo("queued");
        Instant after = jdbc.queryForObject("SELECT clock_timestamp()", java.sql.Timestamp.class).toInstant();
        assertThat(response.nextAttemptAt()).isBetween(before.plusSeconds(attempt == 1 ? 2 : 3), after.plusSeconds(attempt == 1 ? 2 : 3));
        assertThat(jobs.claim(List.of(kind))).isEmpty();
        due(id);
      } else {
        assertThat(response.status()).isEqualTo("failed");
        assertThat(response.error().code()).isEqualTo("JOB_ATTEMPTS_EXHAUSTED");
        assertThat(response.finishedAt()).isNotNull();
        assertThat(response.nextAttemptAt()).isNull();
        assertThat(jobs.claim(List.of(kind))).isEmpty();
      }
    }
  }

  @Test void safeExpiredWorkIsRetriedButManualAndExhaustedWorkStop() {
    UUID owner = owner(); String safe = kind(); String manual = kind(); String last = kind();
    UUID safeId = enqueue(owner, safe, RetryPolicy.SAFE);
    UUID manualId = enqueue(owner, manual, RetryPolicy.MANUAL);
    UUID lastId = enqueue(owner, last, RetryPolicy.SAFE);
    jdbc.update("UPDATE studymate.jobs SET max_attempts = 1 WHERE id = ?", lastId);
    claim(safe); claim(manual); claim(last);
    expire(safeId); expire(manualId); expire(lastId);
    jobs.recoverExpired();
    assertThat(queue.get(owner, safeId).status()).isEqualTo("queued");
    assertThat(queue.get(owner, safeId).attemptCount()).isEqualTo(1);
    assertThat(queue.get(owner, manualId).status()).isEqualTo("failed");
    assertThat(queue.get(owner, manualId).error().code()).isEqualTo("JOB_OUTCOME_UNKNOWN");
    assertThat(queue.get(owner, lastId).error().code()).isEqualTo("JOB_ATTEMPTS_EXHAUSTED");
    assertThat(jobs.claim(List.of(safe, manual, last))).isEmpty();
    due(safeId);
    assertThat(claim(safe).attemptCount()).isEqualTo(2);
  }

  @Test void recoverySkipsLiveLeasesAndExpiredRowsLockedByAnotherTransaction() throws Exception {
    UUID owner = owner(); String kind = kind(); UUID id = enqueue(owner, kind, RetryPolicy.SAFE);
    claim(kind); jobs.recoverExpired();
    assertThat(queue.get(owner, id).status()).isEqualTo("running");
    expire(id);
    try (var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (var lock = connection.prepareStatement("SELECT id FROM studymate.jobs WHERE id = ? FOR UPDATE")) {
        lock.setObject(1, id); lock.executeQuery().close();
        jobs.recoverExpired();
        assertThat(queue.get(owner, id).status()).isEqualTo("running");
      } finally { connection.rollback(); }
    }
    jobs.recoverExpired();
    assertThat(queue.get(owner, id).status()).isEqualTo("queued");
  }

  @Test void obsoleteTokenAndWrongOwnerCannotWriteResultsOrRenew() {
    UUID owner = owner(); String kind = kind(); UUID id = enqueue(owner, kind, RetryPolicy.SAFE);
    var old = claim(kind); expire(id); jobs.recoverExpired(); due(id);
    var current = claim(kind);
    assertThat(current.token()).isNotEqualTo(old.token());
    var forged = new JobLease(id, owner(), kind, json("{}"), current.token(), 2, RetryPolicy.SAFE, 30);
    for (var obsolete : List.of(old, forged)) {
      assertThat(jobs.renew(obsolete)).isFalse();
      assertThat(completion.finish(obsolete, new JobOutcome.Succeeded(() -> { throw new AssertionError("stale callback ran"); }))).isFalse();
    }
    UUID result = UUID.randomUUID();
    assertThat(completion.finish(current, new JobOutcome.Succeeded(() -> {
      jdbc.update("INSERT INTO studymate.stage7_job_effects_test VALUES (?, ?)", id, result);
      return result;
    }))).isTrue();
    assertThat(queue.get(owner, id).resultId()).isEqualTo(result);
    assertThat(jdbc.queryForObject("SELECT result_id FROM studymate.stage7_job_effects_test WHERE job_id = ?", UUID.class, id)).isEqualTo(result);
    assertThat(completion.finish(current, new JobOutcome.Failed(JobError.JOB_PROCESSING_FAILED))).isFalse();
    assertThat(queue.get(owner, id).status()).isEqualTo("succeeded");
  }

  @Test void callbackAndJobCompletionRollBackTogetherOnErrorOrLeaseExpiry() {
    for (boolean expired : new boolean[]{false, true}) {
      UUID owner = owner(); String kind = kind(); UUID id = enqueue(owner, kind, RetryPolicy.SAFE);
      var lease = claim(kind);
      assertThatThrownBy(() -> completion.finish(lease, new JobOutcome.Succeeded(() -> {
        jdbc.update("INSERT INTO studymate.stage7_job_effects_test VALUES (?, ?)", id, UUID.randomUUID());
        if (!expired) throw new DataAccessResourceFailureException("test only private exception detail");
        expire(id);
        return UUID.randomUUID();
      }))).isInstanceOf(expired ? JobCompletion.LostLeaseException.class : DataAccessResourceFailureException.class);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.stage7_job_effects_test WHERE job_id = ?", Integer.class, id)).isZero();
      assertThat(queue.get(owner, id).status()).isEqualTo("running");
      assertThat(queue.get(owner, id).resultId()).isNull();
      assertThat(completion.finish(lease, new JobOutcome.Succeeded(() -> null))).isTrue();
    }
  }

  @Test void cancellationFencesQueuedAndRunningWorkAndIsScopedToOwner() {
    for (boolean running : new boolean[]{false, true}) {
      UUID owner = owner(); String kind = kind(); UUID key = UUID.randomUUID();
      UUID id = queue.enqueue(owner, kind, key, json("{}"), RetryPolicy.SAFE);
      JobLease lease = running ? claim(kind) : null;
      assertThat(queue.cancel(owner(), id)).isFalse();
      assertThat(queue.cancel(owner, id)).isTrue();
      assertThat(queue.cancel(owner, id)).isFalse();
      assertThat(queue.get(owner, id).status()).isEqualTo("cancelled");
      assertThat(queue.get(owner, id).finishedAt()).isNotNull();
      assertThat(queue.get(owner, id).error()).isNull();
      if (lease != null) {
        assertThat(jobs.renew(lease)).isFalse();
        assertThat(completion.finish(lease, new JobOutcome.Succeeded(() -> { throw new AssertionError("cancelled callback ran"); }))).isFalse();
      }
      assertThat(queue.enqueue(owner, kind, key, json("{}"), RetryPolicy.SAFE)).isEqualTo(id);
      assertThat(jobs.claim(List.of(kind))).isEmpty();
    }
  }

  @Test void terminalFailureAndManualRetryNeverAutomaticallyExecuteAgain() {
    for (RetryPolicy policy : RetryPolicy.values()) {
      UUID owner = owner(); String kind = kind(); UUID id = enqueue(owner, kind, policy);
      var lease = claim(kind);
      JobOutcome outcome = policy == RetryPolicy.MANUAL ? new JobOutcome.Retry(JobError.JOB_TEMPORARY_FAILURE)
          : new JobOutcome.Failed(JobError.JOB_PROCESSING_FAILED);
      assertThat(completion.finish(lease, outcome)).isTrue();
      assertThat(queue.get(owner, id).status()).isEqualTo("failed");
      assertThat(queue.get(owner, id).attemptCount()).isEqualTo(1);
      assertThat(jobs.claim(List.of(kind))).isEmpty();
      assertThat(queue.cancel(owner, id)).isFalse();
    }
  }

  @Test void invalidInternalPayloadIsRejectedBeforeInserting() {
    UUID owner = owner(); String kind = kind();
    for (JsonNode payload : List.of(json("[]"), json("null"), json("\"text\""), mapper.createObjectNode().put("text", "x".repeat(16384)))) {
      assertThatThrownBy(() -> queue.enqueue(owner, kind, UUID.randomUUID(), payload, RetryPolicy.SAFE)).isInstanceOf(IllegalArgumentException.class);
    }
    assertThatThrownBy(() -> queue.enqueue(owner, "UPPER", UUID.randomUUID(), json("{}"), RetryPolicy.SAFE)).isInstanceOf(IllegalArgumentException.class);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.jobs WHERE owner_id = ?", Integer.class, owner)).isZero();
  }

  @Test void jobHttpIsPrivateReadOnlyAndNeverExposesPayloadOrLease() throws Exception {
    try (var a = new AuthHttpClient(port); var b = new AuthHttpClient(port); var guest = new AuthHttpClient(port)) {
      String email = "jobs-http-" + UUID.randomUUID() + "@example.com";
      UUID owner = UUID.fromString(a.register(email)); a.data(a.login(email), 200); a.csrf();
      String emailB = "jobs-http-" + UUID.randomUUID() + "@example.com";
      b.register(emailB); b.data(b.login(emailB), 200); b.csrf();
      String kind = kind();
      UUID id = queue.enqueue(owner, kind, UUID.randomUUID(), json("{\"privateMarker\":\"not-for-the-browser\"}"), RetryPolicy.SAFE);
      String path = "/jobs/" + id;
      assertThat(guest.error(guest.send("GET", path, null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      var foreign = b.send("GET", path, null, null);
      var missing = b.send("GET", "/jobs/" + UUID.randomUUID(), null, null);
      assertThat(b.error(foreign, 404)).isEqualTo("JOB_NOT_FOUND");
      assertThat(missing.body()).isEqualTo(foreign.body());
      assertThat(a.error(a.send("GET", "/jobs/1-1-1-1-1", null, null), 400)).isEqualTo("INVALID_ID");
      assertThat(a.error(a.send("GET", path + "?ownerId=forged", null, null), 400)).isEqualTo("INVALID_QUERY");
      var queued = a.send("GET", path, null, null);
      var data = a.data(queued, 200);
      assertThat(data.size()).isEqualTo(11);
      assertThat(data.get("status").asString()).isEqualTo("queued");
      assertThat(data.get("attemptCount").asInt()).isZero();
      assertThat(data.get("resultId").isNull()).isTrue();
      assertThat(data.get("error").isNull()).isTrue();
      assertThat(queued.body()).doesNotContain("privateMarker", "not-for-the-browser", "ownerId", "leaseToken", "operationKey", "payload");
      var lease = claim(kind);
      assertThat(a.data(a.send("GET", path, null, null), 200).get("status").asString()).isEqualTo("running");
      completion.finish(lease, new JobOutcome.Failed(JobError.JOB_PROCESSING_FAILED));
      var failed = a.data(a.send("GET", path, null, null), 200);
      assertThat(failed.at("/error/code").asString()).isEqualTo("JOB_PROCESSING_FAILED");
      assertThat(failed.get("finishedAt").asString()).endsWith("Z");
      for (String method : List.of("POST", "PATCH", "DELETE")) {
        assertThat(a.error(a.send(method, path, json("{}"), a.token), 403)).isEqualTo("ACCESS_DENIED");
      }
      assertThat(queue.get(owner, id).status()).isEqualTo("failed");
      // A session whose user was removed also cannot query an arbitrary job.
      String removedEmail = "jobs-removed-" + UUID.randomUUID() + "@example.com";
      UUID removed = UUID.fromString(guest.register(removedEmail)); guest.data(guest.login(removedEmail), 200);
      jdbc.update("DELETE FROM studymate.users WHERE id = ?", removed);
      assertThat(guest.error(guest.send("GET", path, null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
    }
  }

  private UUID enqueue(UUID owner, String kind, RetryPolicy policy) { return queue.enqueue(owner, kind, UUID.randomUUID(), json("{}"), policy); }
  private JobLease claim(String kind) { return jobs.claim(List.of(kind)).orElseThrow(); }
  private void expire(UUID id) { jdbc.update("UPDATE studymate.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ?", id); }
  private void due(UUID id) { jdbc.update("UPDATE studymate.jobs SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = ?", id); }
  private JsonNode json(String text) { return mapper.readTree(text); }
  private String kind() { return "test.queue." + UUID.randomUUID(); }
  private UUID owner() {
    UUID id = UUID.randomUUID();
    jdbc.update("INSERT INTO studymate.users (id, normalized_email, display_name, password_hash) VALUES (?, ?, 'Job test', '{test-only}unusable')", id, "jobs-" + id + "@example.com");
    return id;
  }
}
