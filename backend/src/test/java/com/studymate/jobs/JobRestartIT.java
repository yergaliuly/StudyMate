package com.studymate.jobs;

import static org.assertj.core.api.Assertions.assertThat;

import com.studymate.PostgresIntegrationTest;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest
class JobRestartIT extends PostgresIntegrationTest {
  @Autowired JobQueue queue;
  @Autowired JdbcTemplate jdbc;
  @Autowired JsonMapper mapper;

  @Test void killedProcessLosesItsLeaseAndNewProcessesRecoverOnlySafeWork() throws Exception {
    jdbc.execute("CREATE TABLE studymate.stage7_job_process_events_test (job_id UUID NOT NULL, attempt INTEGER NOT NULL)");
    jdbc.execute("CREATE TABLE studymate.stage7_job_process_results_test (job_id UUID PRIMARY KEY)");
    try {
      for (var policy : RetryPolicy.values()) {
        UUID owner = UUID.randomUUID();
        jdbc.update("INSERT INTO studymate.users (id, normalized_email, display_name, password_hash) VALUES (?, ?, 'Restart test', '{test-only}unusable')", owner, "job-restart-" + owner + "@example.com");
        String kind = "test.restart." + UUID.randomUUID(); UUID key = UUID.randomUUID();
        UUID id = queue.enqueue(owner, kind, key, mapper.createObjectNode(), policy);
        jdbc.update("UPDATE studymate.jobs SET lease_seconds = 2, execution_timeout_seconds = 30, retry_delay_seconds = 1, max_retry_delay_seconds = 2 WHERE id = ?", id);
        try (var first = start(kind, true)) {
          await(() -> eventCount(id) == 1, first);
          assertThat(queue.get(owner, id).status()).isEqualTo("running");
          first.process().destroyForcibly();
          assertThat(first.process().waitFor(10, TimeUnit.SECONDS)).isTrue();
        }
        try (var second = start(kind, false)) {
          await(() -> List.of("succeeded", "failed").contains(queue.get(owner, id).status()), second);
          var response = queue.get(owner, id);
          if (policy == RetryPolicy.SAFE) {
            assertThat(response.status()).isEqualTo("succeeded");
            assertThat(response.attemptCount()).isEqualTo(2);
            assertThat(eventCount(id)).isEqualTo(2);
            assertThat(response.resultId()).isEqualTo(id);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.stage7_job_process_results_test WHERE job_id = ?", Integer.class, id)).isEqualTo(1);
          } else {
            assertThat(response.status()).isEqualTo("failed");
            assertThat(response.error().code()).isEqualTo("JOB_OUTCOME_UNKNOWN");
            assertThat(response.attemptCount()).isEqualTo(1);
            assertThat(eventCount(id)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.stage7_job_process_results_test WHERE job_id = ?", Integer.class, id)).isZero();
          }
        }
        assertThat(queue.enqueue(owner, kind, key, mapper.createObjectNode(), policy)).isEqualTo(id);
        assertThat(queue.get(owner, id).status()).isEqualTo(policy == RetryPolicy.SAFE ? "succeeded" : "failed");
      }
    } finally {
      jdbc.execute("DROP TABLE studymate.stage7_job_process_results_test");
      jdbc.execute("DROP TABLE studymate.stage7_job_process_events_test");
    }
  }

  private int eventCount(UUID id) { return jdbc.queryForObject("SELECT count(*) FROM studymate.stage7_job_process_events_test WHERE job_id = ?", Integer.class, id); }

  private static RunningProcess start(String kind, boolean hold) throws Exception {
    String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
    Path arguments = Files.createTempFile(Path.of("target"), "jobs-process-", ".args");
    // Java argument file avoids the Windows command-line length limit; it contains no credentials.
    Files.writeString(arguments, "-cp\n\"" + classpath.replace('\\', '/') + "\"\n" + JobProcessMain.class.getName() + "\n");
    Path log = Files.createTempFile(Path.of("target"), "jobs-process-", ".log");
    var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
        "@" + arguments, "--server.address=127.0.0.1", "--server.port=0", "--studymate.jobs.enabled=true",
        "--studymate.jobs.poll-interval-ms=100", "--studymate.jobs.heartbeat-interval-ms=200",
        "--studymate.jobs.test.kind=" + kind, "--studymate.jobs.test.hold=" + hold)
        .redirectErrorStream(true).redirectOutput(log.toFile());
    for (String suffix : new String[]{"URL", "USERNAME", "PASSWORD"}) {
      String value = System.getenv("STUDYMATE_TEST_DATABASE_" + suffix);
      if (value == null || value.isBlank()) throw new IllegalStateException("Missing dedicated test database setting");
      builder.environment().put("STUDYMATE_DATABASE_" + suffix, value);
    }
    return new RunningProcess(builder.start(), log);
  }

  private static void await(BooleanSupplier ready, RunningProcess child) throws Exception {
    long deadline = System.nanoTime() + Duration.ofSeconds(40).toNanos();
    while (System.nanoTime() < deadline && child.process().isAlive()) {
      if (ready.getAsBoolean()) return;
      Thread.sleep(50);
    }
    throw new AssertionError("Child worker did not reach expected state; see " + child.log());
  }

  private record RunningProcess(Process process, Path log) implements AutoCloseable {
    @Override public void close() throws Exception {
      if (!process.isAlive()) return;
      process.destroy();
      if (!process.waitFor(10, TimeUnit.SECONDS)) {
        process.destroyForcibly();
        if (!process.waitFor(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test job process failed to stop");
      }
    }
  }
}
