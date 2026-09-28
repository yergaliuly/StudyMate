package com.studymate.jobs;

/** Trusted server adapter. Execution is outside a transaction; timeouts/interruption must be respected.
 * SAFE jobs can execute again after lease loss. External effects need their own idempotency key.
 * No production handlers are installed at stage 7; test handlers live exclusively in src/test. */
public interface JobHandler {
  String kind();
  JobOutcome execute(JobLease job) throws Exception;
}
