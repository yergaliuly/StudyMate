package com.studymate.quizzes;

import com.studymate.ai.AiFailure;
import com.studymate.ai.QuizProvider;
import com.studymate.ai.SummaryProvider;
import com.studymate.jobs.JobError;
import com.studymate.jobs.JobHandler;
import com.studymate.jobs.JobLease;
import com.studymate.jobs.JobOutcome;
import java.util.UUID;
import org.springframework.context.annotation.Conditional;
import org.springframework.stereotype.Component;

@Component
@Conditional(QuizHandlerCondition.class)
class QuizHandler implements JobHandler {
  private final QuizRepository repository;
  private final QuizGeneration generation;
  QuizHandler(QuizRepository repository, QuizProvider provider, SummaryProvider notes) {
    this.repository = repository; this.generation = new QuizGeneration(provider, notes);
  }
  public String kind() { return QuizRepository.KIND; }
  public JobOutcome execute(JobLease lease) throws InterruptedException {
    UUID material = UUID.fromString(lease.payload().get("materialId").asString());
    var pages = repository.source(lease.ownerId(), material, lease.id());
    if (pages.isEmpty()) return new JobOutcome.Failed(JobError.AI_UNAVAILABLE);
    try {
      var result = generation.generate(pages);
      return new JobOutcome.Succeeded(() -> repository.save(lease.ownerId(), material, lease.id(), result));
    } catch (AiFailure failure) { return new JobOutcome.Failed(failure.code()); }
  }
}
