package com.studymate.jobs;

import static org.assertj.core.api.Assertions.assertThat;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/** Test-only bridge to the real lease/transaction machinery; not part of the application API. */
public class MaterialJobTestDriver {
  private final JobRepository jobs;
  private final JobCompletion completion;
  private final JdbcTemplate jdbc;
  public MaterialJobTestDriver(JobRepository jobs, JobCompletion completion, JdbcTemplate jdbc) {
    this.jobs=jobs; this.completion=completion; this.jdbc=jdbc;
  }
  public JobLease claim(UUID id) {
    jdbc.update("UPDATE studymate.jobs SET next_attempt_at=clock_timestamp()-INTERVAL '1 day' WHERE id=? AND status='queued'",id);
    var lease=jobs.claim(List.of("material.delete")).orElseThrow();
    assertThat(lease.id()).isEqualTo(id); return lease;
  }
  public boolean finish(JobLease lease,JobOutcome outcome) { return completion.finish(lease,outcome); }
  public void run(UUID id, JobHandler handler) throws Exception { var lease=claim(id); assertThat(finish(lease,handler.execute(lease))).isTrue(); }
  public void recover() { jobs.recoverExpired(); }
}
