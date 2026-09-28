package com.studymate.jobs;

import com.studymate.StudyMateApplication;
import java.util.concurrent.CountDownLatch;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;

/** Test-classpath-only executable. No test handler/endpoint is packaged in the production JAR. */
public final class JobProcessMain {
  public static void main(String[] args) {
    SpringApplication.run(new Class<?>[]{StudyMateApplication.class, TestAdapter.class}, args);
  }

  @TestConfiguration(proxyBeanMethods = false)
  static class TestAdapter {
    @Bean JobHandler restartTestHandler(JdbcTemplate jdbc, @Value("${studymate.jobs.test.kind}") String kind,
        @Value("${studymate.jobs.test.hold:false}") boolean hold) {
      return new JobHandler() {
        public String kind() { return kind; }
        public JobOutcome execute(JobLease job) throws Exception {
          // Observation of test execution, not a domain effect. The actual result is fenced below.
          jdbc.update("INSERT INTO studymate.stage7_job_process_events_test (job_id, attempt) VALUES (?, ?)", job.id(), job.attemptCount());
          if (hold) new CountDownLatch(1).await();
          return new JobOutcome.Succeeded(() -> {
            jdbc.update("INSERT INTO studymate.stage7_job_process_results_test (job_id) VALUES (?)", job.id());
            return job.id();
          });
        }
      };
    }
  }
}
