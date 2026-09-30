package com.studymate.ai;

import com.studymate.jobs.JobError;
import java.util.Set;

final class DisabledSummaryProvider implements SummaryProvider {
  public boolean available() { return false; }
  public String model() { return "disabled"; }
  public Chunk summarize(String source, Set<Integer> allowedPages) throws AiFailure {
    throw new AiFailure(JobError.AI_UNAVAILABLE);
  }
}
