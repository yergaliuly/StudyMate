package com.studymate.jobs;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.after;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import tools.jackson.databind.json.JsonMapper;

class JobWorkerTest {
  @Test void failedHeartbeatRevokesExecutionAndNeverResumesRenewingItsLease() throws Exception {
    var jobs = mock(JobRepository.class); var completion = mock(JobCompletion.class);
    var lease = new JobLease(UUID.randomUUID(), UUID.randomUUID(), "test.heartbeat", JsonMapper.builder().build().createObjectNode(),
        UUID.randomUUID(), 1, RetryPolicy.SAFE, 1);
    when(jobs.claim(anyCollection())).thenReturn(Optional.of(lease), Optional.empty());
    when(jobs.renew(lease)).thenThrow(new DataAccessResourceFailureException("private connection detail"));
    var entered = new CountDownLatch(1); var interrupted = new CountDownLatch(1); var release = new CountDownLatch(1);
    JobHandler handler = new JobHandler() {
      public String kind() { return lease.kind(); }
      public JobOutcome execute(JobLease ignored) throws Exception {
        entered.countDown();
        while (release.getCount() > 0) {
          try { release.await(100, TimeUnit.MILLISECONDS); }
          catch (InterruptedException exception) { interrupted.countDown(); }
        }
        return new JobOutcome.Succeeded(() -> null);
      }
    };
    try (var worker = new JobWorker(jobs, completion, new JobProperties(100, 100, 1, 2, 3, 1, 2), List.of(handler))) {
      try {
        worker.start();
        assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(interrupted.await(5, TimeUnit.SECONDS)).isTrue();
        verify(jobs, after(500).times(1)).renew(lease);
      } finally { release.countDown(); }
    }
    verify(completion, never()).finish(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
  }
}
