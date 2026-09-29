package com.studymate.jobs;

/** Trusted server adapter. Execution is outside a transaction; timeouts/interruption must be respected.
 * SAFE jobs can execute again after lease loss. External effects need their own idempotency key.
 * Material cleanup is installed only when R2 is explicitly enabled. Test adapters live in src/test. */
public interface JobHandler {
  String kind();
  JobOutcome execute(JobLease job) throws Exception;
}
