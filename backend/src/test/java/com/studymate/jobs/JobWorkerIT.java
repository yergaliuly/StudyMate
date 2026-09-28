package com.studymate.jobs;

import static org.assertj.core.api.Assertions.assertThat;

import com.studymate.PostgresIntegrationTest;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest
class JobWorkerIT extends PostgresIntegrationTest {
  @Autowired JobRepository jobs;
  @Autowired JobQueue queue;
  @Autowired JobCompletion completion;
  @Autowired JdbcTemplate jdbc;
  @Autowired JsonMapper mapper;
  private final JobProperties settings = new JobProperties(100, 100, 1, 2, 3, 1, 2);

  @Test void workerExecutesOutsideTransactionRenewsLeaseAndPersistsInsideTransaction() throws Exception {
    var item = item(RetryPolicy.SAFE, 10);
    var entered = new CountDownLatch(1); var release = new CountDownLatch(1);
    var outside = new AtomicBoolean(); var inside = new AtomicBoolean();
    UUID result = UUID.randomUUID();
    var handler = handler(item.kind(), job -> {
      outside.set(!TransactionSynchronizationManager.isActualTransactionActive());
      entered.countDown();
      if (!release.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("test handler release timeout");
      return new JobOutcome.Succeeded(() -> { inside.set(TransactionSynchronizationManager.isActualTransactionActive()); return result; });
    });
    // Current heartbeat setting is longer than this job's old, persisted one-second lease.
    try (var worker = new JobWorker(jobs, completion, new JobProperties(100, 5000, 30, 120, 3, 2, 60), List.of(handler))) {
      worker.start();
      assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
      Instant initialLease = jdbc.queryForObject("SELECT lease_expires_at FROM studymate.jobs WHERE id = ?", java.sql.Timestamp.class, item.id()).toInstant();
      await(() -> Instant.now().isAfter(initialLease.plusMillis(150)));
      assertThat(queue.get(item.owner(), item.id()).status()).isEqualTo("running");
      assertThat(queue.get(item.owner(), item.id()).attemptCount()).isEqualTo(1);
      assertThat(jdbc.queryForObject("SELECT lease_expires_at > clock_timestamp() FROM studymate.jobs WHERE id = ?", Boolean.class, item.id())).isTrue();
      release.countDown();
      await(() -> queue.get(item.owner(), item.id()).status().equals("succeeded"));
      assertThat(outside).isTrue(); assertThat(inside).isTrue();
      assertThat(queue.get(item.owner(), item.id()).resultId()).isEqualTo(result);
    } finally { release.countDown(); }
  }

  @Test void twoWorkersExecuteOneJobAndRetryOnlyAfterItsDelay() throws Exception {
    var item = item(RetryPolicy.SAFE, 10);
    var active = new AtomicInteger(); var maximum = new AtomicInteger(); var calls = new AtomicInteger();
    var times = new java.util.concurrent.CopyOnWriteArrayList<Instant>();
    var handler = handler(item.kind(), job -> {
      maximum.accumulateAndGet(active.incrementAndGet(), Math::max);
      try {
        times.add(Instant.now()); calls.incrementAndGet();
        return job.attemptCount() == 1 ? new JobOutcome.Retry(JobError.JOB_TEMPORARY_FAILURE) : new JobOutcome.Succeeded(() -> null);
      } finally { active.decrementAndGet(); }
    });
    try (var first = worker(handler); var second = worker(handler)) {
      first.start(); second.start();
      await(() -> queue.get(item.owner(), item.id()).status().equals("succeeded"));
      assertThat(calls.get()).isEqualTo(2);
      assertThat(maximum.get()).isEqualTo(1);
      assertThat(Duration.between(times.get(0), times.get(1))).isGreaterThanOrEqualTo(Duration.ofSeconds(1));
    }
  }

  @Test void timeoutInterruptsTheHandlerAndManualExecutionIsNeverRepeated() throws Exception {
    var item = item(RetryPolicy.MANUAL, 2);
    var interrupted = new AtomicBoolean(); var calls = new AtomicInteger();
    var handler = handler(item.kind(), job -> {
      calls.incrementAndGet();
      try { new CountDownLatch(1).await(15, TimeUnit.SECONDS); }
      catch (InterruptedException exception) { interrupted.set(true); throw exception; }
      return new JobOutcome.Succeeded(() -> { throw new AssertionError("timed out callback ran"); });
    });
    try (var worker = worker(handler)) {
      worker.start();
      await(() -> queue.get(item.owner(), item.id()).status().equals("failed"));
      await(interrupted::get);
      assertThat(queue.get(item.owner(), item.id()).error().code()).isEqualTo("JOB_OUTCOME_UNKNOWN");
      assertThat(calls.get()).isEqualTo(1);
    }
  }

  @Test void cancelledHandlerCannotPublishEvenWhenItIgnoresInterruption() throws Exception {
    var item = item(RetryPolicy.SAFE, 10);
    var entered = new CountDownLatch(1); var release = new CountDownLatch(1); var exited = new CountDownLatch(1);
    var persisted = new AtomicBoolean();
    var handler = handler(item.kind(), job -> {
      entered.countDown();
      try {
        while (release.getCount() != 0) {
          try { release.await(100, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) { /* Simulate a non-cooperative adapter. */ }
        }
        return new JobOutcome.Succeeded(() -> { persisted.set(true); return null; });
      } finally { exited.countDown(); }
    });
    try (var worker = worker(handler)) {
      worker.start(); assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
      assertThat(queue.cancel(item.owner(), item.id())).isTrue();
      release.countDown(); assertThat(exited.await(5, TimeUnit.SECONDS)).isTrue();
    } finally { release.countDown(); }
    assertThat(persisted).isFalse();
    assertThat(queue.get(item.owner(), item.id()).status()).isEqualTo("cancelled");
  }

  @Test void unexpectedExceptionsExposeOnlySafeErrorsAndDoNotKillThePollingLoop() throws Exception {
    for (var policy : RetryPolicy.values()) {
      var first = item(policy, 10);
      UUID next = queue.enqueue(first.owner(), first.kind(), UUID.randomUUID(), mapper.createObjectNode(), policy);
      var handler = handler(first.kind(), job -> {
        if (job.id().equals(first.id())) throw new IllegalStateException("private test password=do-not-persist, SQL and paths");
        return new JobOutcome.Succeeded(() -> null);
      });
      try (var worker = worker(handler)) {
        worker.start();
        await(() -> queue.get(first.owner(), next).status().equals("succeeded"));
        var failed = queue.get(first.owner(), first.id());
        assertThat(failed.status()).isEqualTo("failed");
        assertThat(failed.error().code()).isEqualTo(policy == RetryPolicy.SAFE ? "JOB_PROCESSING_FAILED" : "JOB_OUTCOME_UNKNOWN");
        assertThat(mapper.writeValueAsString(failed)).doesNotContain("password", "SQL", "paths", "IllegalStateException");
      }
    }
  }

  @Test void expiredWorkIsRecoveredOnWorkerStartup() throws Exception {
    var item = item(RetryPolicy.SAFE, 10);
    var old = jobs.claim(List.of(item.kind())).orElseThrow();
    jdbc.update("UPDATE studymate.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ?", item.id());
    try (var worker = worker(handler(item.kind(), job -> new JobOutcome.Succeeded(() -> null)))) {
      worker.start();
      await(() -> queue.get(item.owner(), item.id()).status().equals("succeeded"));
      assertThat(queue.get(item.owner(), item.id()).attemptCount()).isEqualTo(2);
      assertThat(completion.finish(old, new JobOutcome.Failed(JobError.JOB_PROCESSING_FAILED))).isFalse();
    }
  }

  @Test void shutdownLeavesUncertainWorkForLeaseRecovery() throws Exception {
    var item = item(RetryPolicy.SAFE, 10);
    var entered = new CountDownLatch(1);
    try (var worker = worker(handler(item.kind(), job -> {
      entered.countDown(); new CountDownLatch(1).await(); return new JobOutcome.Succeeded(() -> null);
    }))) {
      worker.start(); assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
    }
    assertThat(queue.get(item.owner(), item.id()).status()).isEqualTo("running");
    try (var successor = worker(handler(item.kind(), job -> new JobOutcome.Succeeded(() -> null)))) {
      successor.start();
      await(() -> queue.get(item.owner(), item.id()).status().equals("succeeded"));
      assertThat(queue.get(item.owner(), item.id()).attemptCount()).isEqualTo(2);
    }
  }

  private record Item(UUID owner, UUID id, String kind) {}
  private Item item(RetryPolicy policy, int timeout) {
    UUID owner = UUID.randomUUID();
    jdbc.update("INSERT INTO studymate.users (id, normalized_email, display_name, password_hash) VALUES (?, ?, 'Worker test', '{test-only}unusable')", owner, "worker-" + owner + "@example.com");
    String kind = "test.worker." + UUID.randomUUID();
    UUID id = queue.enqueue(owner, kind, UUID.randomUUID(), mapper.createObjectNode(), policy);
    jdbc.update("UPDATE studymate.jobs SET lease_seconds = 1, execution_timeout_seconds = ?, retry_delay_seconds = 1, max_retry_delay_seconds = 2 WHERE id = ?", timeout, id);
    return new Item(owner, id, kind);
  }
  private JobWorker worker(JobHandler handler) { return new JobWorker(jobs, completion, settings, List.of(handler)); }
  @FunctionalInterface interface Work { JobOutcome run(JobLease lease) throws Exception; }
  private JobHandler handler(String kind, Work work) {
    return new JobHandler() {
      public String kind() { return kind; }
      public JobOutcome execute(JobLease lease) throws Exception { return work.run(lease); }
    };
  }
  private static void await(BooleanSupplier ready) throws Exception {
    long until = System.nanoTime() + Duration.ofSeconds(10).toNanos();
    while (System.nanoTime() < until) { if (ready.getAsBoolean()) return; Thread.sleep(25); }
    throw new AssertionError("Worker did not reach the expected state before the test deadline");
  }
}
