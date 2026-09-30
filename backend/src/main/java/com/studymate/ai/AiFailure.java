package com.studymate.ai;

import com.studymate.jobs.JobError;

/** No provider response body, lecture text or credential is retained in this exception. */
public final class AiFailure extends Exception {
  private final JobError code;
  public AiFailure(JobError code) { super(code.name()); this.code = code; }
  public JobError code() { return code; }
}
