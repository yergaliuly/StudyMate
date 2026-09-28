package com.studymate.jobs;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class JobCompletion {
  private final JobRepository jobs;
  JobCompletion(JobRepository jobs) { this.jobs = jobs; }

  @Transactional(timeout = 10)
  public boolean finish(JobLease lease, JobOutcome outcome) {
    if (!jobs.lock(lease)) return false;
    boolean saved = switch (outcome) {
      case JobOutcome.Succeeded success -> jobs.succeed(lease, success.completion().persist());
      case JobOutcome.Retry retry -> jobs.fail(lease, retry.error(), true);
      case JobOutcome.Failed failed -> jobs.fail(lease, failed.error(), false);
    };
    // The lease may expire while the completion callback runs. Roll back its domain writes too.
    if (!saved) throw new LostLeaseException();
    return true;
  }

  static final class LostLeaseException extends RuntimeException {
    LostLeaseException() { super("Job lease no longer valid"); }
  }
}
