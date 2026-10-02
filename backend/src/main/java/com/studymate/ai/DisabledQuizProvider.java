package com.studymate.ai;

import com.studymate.jobs.JobError;
import java.util.Set;

final class DisabledQuizProvider implements QuizProvider {
  public boolean available() { return false; }
  public String model() { return "disabled"; }
  public Result generate(String source, Set<Integer> allowedPages) throws AiFailure {
    throw new AiFailure(JobError.AI_UNAVAILABLE);
  }
}
