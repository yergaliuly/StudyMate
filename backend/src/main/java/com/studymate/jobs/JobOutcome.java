package com.studymate.jobs;

import java.util.Objects;
import java.util.UUID;

public sealed interface JobOutcome {
  /** Persist only short database changes here. Called in the fenced completion transaction.
   * External calls belong in JobHandler.execute, never in this callback. Domain adapters
   * must also recheck their resource's owner/version/deletion state before publishing results. */
  @FunctionalInterface
  interface Completion { UUID persist(); }

  record Succeeded(Completion completion) implements JobOutcome {
    public Succeeded { Objects.requireNonNull(completion); }
  }
  record Retry(JobError error) implements JobOutcome {
    public Retry { Objects.requireNonNull(error); }
  }
  record Failed(JobError error) implements JobOutcome {
    public Failed { Objects.requireNonNull(error); }
  }
}
