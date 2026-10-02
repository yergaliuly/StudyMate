package com.studymate.quizzes;

import com.studymate.ai.SourceText;
import com.studymate.common.api.ApiException;
import com.studymate.jobs.JobError;
import com.studymate.jobs.JobQueue;
import com.studymate.jobs.RetryPolicy;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

@Repository
class QuizRepository {
  static final String KIND = "material.quiz";
  private static final SecureRandom RANDOM = new SecureRandom();
  private final JdbcClient jdbc;
  private final JobQueue jobs;
  private final JsonMapper json;
  QuizRepository(JdbcClient jdbc, JobQueue jobs, JsonMapper json) {
    this.jdbc = jdbc; this.jobs = jobs; this.json = json;
  }
  record Start(UUID materialId, UUID jobId) {}
  record Error(String code, String message) {}
  record Generation(String status, UUID jobId, Error error) {}
  record Info(UUID id, UUID materialId, long version, int questionCount, String model, Instant createdAt) {}
  record Meta(long page, int pageSize, long total, Generation generation) {}
  record Page(List<Info> data, Meta meta) {}
  // These projections intentionally have no answer, explanation or source-reference fields.
  record Option(UUID id, int position, String text) {}
  record Question(UUID id, int position, String text, List<Option> options) {}
  record View(UUID id, UUID materialId, long version, int questionCount, String model, Instant createdAt, List<Question> questions) {}
  private record State(String storage, String extraction, UUID jobId, String jobStatus, String errorCode) {}

  @Transactional(timeout = 10)
  public Start start(UUID owner, UUID material, UUID key) {
    lockOwner(owner);
    State state = state(owner, material, true);
    requireStored(state);
    if (!"succeeded".equals(state.extraction()))
      throw error(HttpStatus.CONFLICT, "TEXT_NOT_READY", "Дождись извлечения текста PDF.");
    String payload = json.writeValueAsString(Map.of("materialId", material));
    var prior = jdbc.sql("""
        SELECT id,payload=CAST(:payload AS jsonb) AS matches FROM studymate.jobs
        WHERE owner_id=:owner AND kind=:kind AND operation_key=:key
        """).param("owner", owner).param("kind", KIND).param("key", key).param("payload", payload)
        .query((r,n) -> {
          if (!r.getBoolean("matches")) throw error(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_REUSED", "Ключ уже использован для другого материала.");
          return r.getObject("id", UUID.class);
        }).optional();
    if (prior.isPresent()) return new Start(material, prior.get());
    if ("queued".equals(state.jobStatus()) || "running".equals(state.jobStatus()))
      throw new ApiException(HttpStatus.CONFLICT, "QUIZ_IN_PROGRESS", "Тест уже создаётся.", Map.of(), 2);
    UUID job = jobs.enqueue(owner, KIND, key, json.valueToTree(Map.of("materialId", material)), RetryPolicy.MANUAL, 1200);
    jdbc.sql("UPDATE studymate.materials SET quiz_job_id=:job,updated_at=clock_timestamp() WHERE owner_id=:owner AND id=:material")
        .param("job", job).param("owner", owner).param("material", material).update();
    return new Start(material, job);
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ, timeout = 10)
  public Page list(UUID owner, UUID material, QuizQuery query) {
    State state = state(owner, material, false);
    requireStored(state);
    long total = jdbc.sql("SELECT count(*) FROM studymate.quizzes WHERE owner_id=:owner AND material_id=:material")
        .param("owner", owner).param("material", material).query(Long.class).single();
    var rows = jdbc.sql("""
        SELECT id,material_id,version,question_count,model,created_at FROM studymate.quizzes
        WHERE owner_id=:owner AND material_id=:material ORDER BY version DESC LIMIT :limit OFFSET :offset
        """).param("owner", owner).param("material", material).param("limit", query.pageSize()).param("offset", query.offset())
        .query((r,n) -> info(r)).list();
    JobError failure = "failed".equals(state.jobStatus()) ? JobError.valueOf(state.errorCode()) : null;
    String status = state.jobStatus() == null ? "not_started" : "succeeded".equals(state.jobStatus()) ? "ready" : state.jobStatus();
    return new Page(rows, new Meta(query.page(), query.pageSize(), total,
        new Generation(status, state.jobId(), failure == null ? null : new Error(failure.name(), failure.message()))));
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ, timeout = 10)
  public View get(UUID owner, UUID quiz) {
    Info info = jdbc.sql("""
        SELECT q.id,q.material_id,q.version,q.question_count,q.model,q.created_at,o.state
        FROM studymate.quizzes q
        JOIN studymate.materials m ON m.id=q.material_id AND m.owner_id=q.owner_id
        JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
        WHERE q.id=:quiz AND q.owner_id=:owner
        """).param("quiz", quiz).param("owner", owner).query((r,n) -> {
          if (!"stored".equals(r.getString("state"))) throw unavailable();
          return info(r);
        }).optional().orElseThrow(() -> error(HttpStatus.NOT_FOUND, "QUIZ_NOT_FOUND", "Тест не найден."));
    var questions = jdbc.sql("SELECT id,position,text_content FROM studymate.quiz_questions WHERE quiz_id=:quiz ORDER BY position")
        .param("quiz", quiz).query((r,n) -> {
          UUID id = r.getObject("id", UUID.class);
          var options = jdbc.sql("SELECT id,position,text_content FROM studymate.quiz_options WHERE question_id=:id ORDER BY position")
              .param("id", id).query((o,i) -> new Option(o.getObject("id", UUID.class), o.getInt("position"), o.getString("text_content"))).list();
          return new Question(id, r.getInt("position"), r.getString("text_content"), options);
        }).list();
    return new View(info.id(), info.materialId(), info.version(), info.questionCount(), info.model(), info.createdAt(), questions);
  }

  List<SourceText.Page> source(UUID owner, UUID material, UUID job) {
    return jdbc.sql("""
        SELECT p.page_number,p.text_content FROM studymate.materials m
        JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
        JOIN studymate.jobs extracted ON extracted.id=m.processing_job_id AND extracted.owner_id=m.owner_id
        JOIN studymate.material_pages p ON p.material_id=m.id
        WHERE m.owner_id=:owner AND m.id=:material AND m.quiz_job_id=:job
          AND o.state='stored' AND extracted.status='succeeded' ORDER BY p.page_number
        """).param("owner", owner).param("material", material).param("job", job)
        .query((r,n) -> new SourceText.Page(r.getInt(1), r.getString(2))).list();
  }

  /** Invoked inside JobCompletion after its lease/job lock; publishes all questions atomically. */
  UUID save(UUID owner, UUID material, UUID job, QuizGeneration.Result result) {
    lockOwner(owner);
    State state = state(owner, material, true);
    if (!"stored".equals(state.storage()) || !job.equals(state.jobId()) || !"succeeded".equals(state.extraction()))
      throw new IllegalStateException("Quiz generation is no longer current");
    long version = jdbc.sql("SELECT COALESCE(max(version),0)+1 FROM studymate.quizzes WHERE material_id=:material")
        .param("material", material).query(Long.class).single();
    UUID quiz = UUID.randomUUID();
    jdbc.sql("""
        INSERT INTO studymate.quizzes(id,material_id,owner_id,version,generation_job_id,question_count,model,input_tokens,output_tokens)
        VALUES (:id,:material,:owner,:version,:job,10,:model,:input,:output)
        """).param("id", quiz).param("material", material).param("owner", owner).param("version", version).param("job", job)
        .param("model", result.model()).param("input", result.inputTokens()).param("output", result.outputTokens()).update();
    int position = 0;
    for (var question : result.questions()) {
      UUID id = UUID.randomUUID();
      record SavedOption(UUID id, String text, boolean correct) {}
      var options = new ArrayList<SavedOption>();
      for (int i = 0; i < 4; i++) options.add(new SavedOption(UUID.randomUUID(), question.options().get(i), i == question.correctIndex()));
      Collections.shuffle(options, RANDOM);
      UUID correct = options.stream().filter(SavedOption::correct).findFirst().orElseThrow().id();
      jdbc.sql("""
          INSERT INTO studymate.quiz_questions(id,quiz_id,position,text_content,correct_option_id,explanation,source_pages)
          VALUES (:id,:quiz,:position,:text,:correct,:explanation,CAST(:pages AS jsonb))
          """).param("id", id).param("quiz", quiz).param("position", ++position).param("text", question.text())
          .param("correct", correct).param("explanation", question.explanation())
          .param("pages", json.writeValueAsString(question.sourcePages())).update();
      for (int i = 0; i < options.size(); i++) {
        var option = options.get(i);
        jdbc.sql("INSERT INTO studymate.quiz_options(id,question_id,position,text_content) VALUES (:id,:question,:position,:text)")
            .param("id", option.id()).param("question", id).param("position", i + 1).param("text", option.text()).update();
      }
    }
    return quiz;
  }

  private State state(UUID owner, UUID material, boolean lock) {
    return jdbc.sql("""
        SELECT o.state,extracted.status AS extraction,m.quiz_job_id,j.status AS quiz_status,j.error_code
        FROM studymate.materials m JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
        LEFT JOIN studymate.jobs extracted ON extracted.id=m.processing_job_id AND extracted.owner_id=m.owner_id
        LEFT JOIN studymate.jobs j ON j.id=m.quiz_job_id AND j.owner_id=m.owner_id
        WHERE m.owner_id=:owner AND m.id=:material
        """ + (lock ? " FOR UPDATE OF o,m" : "")).param("owner", owner).param("material", material)
        .query((r,n) -> new State(r.getString("state"), r.getString("extraction"), r.getObject("quiz_job_id", UUID.class),
            r.getString("quiz_status"), r.getString("error_code")))
        .optional().orElseThrow(() -> error(HttpStatus.NOT_FOUND, "MATERIAL_NOT_FOUND", "Материал не найден."));
  }
  private static Info info(ResultSet r) throws SQLException {
    return new Info(r.getObject("id", UUID.class), r.getObject("material_id", UUID.class), r.getLong("version"),
        r.getInt("question_count"), r.getString("model"), r.getTimestamp("created_at").toInstant());
  }
  private void lockOwner(UUID owner) {
    jdbc.sql("SELECT id FROM studymate.users WHERE id=:owner FOR UPDATE").param("owner", owner).query(UUID.class).single();
  }
  private static void requireStored(State state) { if (!"stored".equals(state.storage())) throw unavailable(); }
  private static ApiException unavailable() { return error(HttpStatus.CONFLICT, "MATERIAL_NOT_AVAILABLE", "Материал недоступен."); }
  private static ApiException error(HttpStatus status, String code, String message) { return new ApiException(status, code, message, Map.of()); }
}
