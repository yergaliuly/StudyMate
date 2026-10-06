package com.studymate.summaries;

import com.studymate.common.api.ApiException;
import com.studymate.jobs.JobError;
import com.studymate.jobs.JobQueue;
import com.studymate.jobs.RetryPolicy;
import com.studymate.pilot.PilotLimits;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

@Repository
class SummaryRepository {
  static final String KIND = "material.summary";
  private final JdbcClient jdbc;
  private final JobQueue jobs;
  private final JsonMapper json;
  private final PilotLimits limits;
  SummaryRepository(JdbcClient jdbc, JobQueue jobs, JsonMapper json, PilotLimits limits) {
    this.jdbc = jdbc; this.jobs = jobs; this.json = json; this.limits=limits;
  }

  record Start(UUID materialId, UUID jobId) {}
  record Error(String code, String message) {}
  record View(UUID materialId, String status, UUID jobId, Long version, String content,
      List<Integer> sourcePages, String origin, String model, Integer inputTokens, Integer outputTokens,
      Instant createdAt, Instant updatedAt, Error error) {}
  private record State(String storage, String extraction, UUID jobId, String jobStatus) {}

  @Transactional(timeout = 10)
  public Start start(UUID owner, UUID material, UUID key) {
    lockOwner(owner);
    State state = state(owner, material, true);
    if (!"stored".equals(state.storage())) throw unavailable();
    if (!"succeeded".equals(state.extraction())) throw error(HttpStatus.CONFLICT, "TEXT_NOT_READY", "Дождись извлечения текста PDF.");
    String payload = json.writeValueAsString(Map.of("materialId", material));
    var prior = jdbc.sql("""
        SELECT id, payload=CAST(:payload AS jsonb) AS matches FROM studymate.jobs
        WHERE owner_id=:owner AND kind=:kind AND operation_key=:key
        """).param("owner", owner).param("kind", KIND).param("key", key).param("payload", payload)
        .query((r, n) -> {
          if (!r.getBoolean("matches")) throw error(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_REUSED", "Ключ уже использован для другого материала.");
          return r.getObject("id", UUID.class);
        }).optional();
    if (prior.isPresent()) return new Start(material, prior.get());
    if ("queued".equals(state.jobStatus()) || "running".equals(state.jobStatus()))
      throw new ApiException(HttpStatus.CONFLICT, "SUMMARY_IN_PROGRESS", "Конспект уже создаётся.", Map.of(), 2);
    limits.aiGeneration(owner);
    UUID job = jobs.enqueue(owner, KIND, key, json.valueToTree(Map.of("materialId", material)), RetryPolicy.MANUAL, 1200);
    jdbc.sql("INSERT INTO studymate.material_summaries(material_id) VALUES (:material) ON CONFLICT DO NOTHING")
        .param("material", material).update();
    jdbc.sql("UPDATE studymate.materials SET summary_job_id=:job,updated_at=clock_timestamp() WHERE id=:material AND owner_id=:owner")
        .param("job", job).param("material", material).param("owner", owner).update();
    return new Start(material, job);
  }

  View get(UUID owner, UUID material) {
    return jdbc.sql("""
        SELECT m.id,o.state,r.material_id AS has_summary,r.version,r.updated_at,m.summary_job_id,
          j.status AS job_status,j.error_code,v.content,v.source_pages,v.origin,v.model,
          v.input_tokens,v.output_tokens,v.created_at
        FROM studymate.materials m
        JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
        LEFT JOIN studymate.material_summaries r ON r.material_id=m.id
        LEFT JOIN studymate.jobs j ON j.id=m.summary_job_id AND j.owner_id=m.owner_id
        LEFT JOIN studymate.summary_versions v ON v.material_id=r.material_id AND v.version=r.version
        WHERE m.owner_id=:owner AND m.id=:material
        """).param("owner", owner).param("material", material)
        .query((r, n) -> view(r)).optional().orElseThrow(SummaryRepository::notFound);
  }

  private View view(ResultSet r) throws SQLException {
    if (!"stored".equals(r.getString("state"))) throw unavailable();
    if (r.getObject("has_summary") == null) throw error(HttpStatus.NOT_FOUND, "SUMMARY_NOT_FOUND", "Конспект ещё не создавался.");
    String jobStatus = r.getString("job_status");
    String status = "succeeded".equals(jobStatus) ? "ready" : jobStatus;
    JobError jobError = "failed".equals(jobStatus) ? JobError.valueOf(r.getString("error_code")) : null;
    String sources = r.getString("source_pages");
    List<Integer> pages = new ArrayList<>();
    if (sources != null) for (var page : json.readTree(sources)) pages.add(page.asInt());
    long version = r.getLong("version");
    return new View(r.getObject("id", UUID.class), status, r.getObject("summary_job_id", UUID.class),
        version == 0 ? null : version, r.getString("content"), version == 0 ? null : List.copyOf(pages),
        r.getString("origin"), r.getString("model"), r.getObject("input_tokens", Integer.class),
        r.getObject("output_tokens", Integer.class), instant(r, "created_at"), instant(r, "updated_at"),
        jobError == null ? null : new Error(jobError.name(), jobError.message()));
  }

  List<SummaryGeneration.SourcePage> source(UUID owner, UUID material, UUID job) {
    return jdbc.sql("""
        SELECT p.page_number,p.text_content FROM studymate.materials m
        JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
        JOIN studymate.jobs extracted ON extracted.id=m.processing_job_id AND extracted.owner_id=m.owner_id
        JOIN studymate.material_pages p ON p.material_id=m.id
        WHERE m.owner_id=:owner AND m.id=:material AND m.summary_job_id=:job
          AND o.state='stored' AND extracted.status='succeeded'
        ORDER BY p.page_number
        """).param("owner", owner).param("material", material).param("job", job)
        .query((r, n) -> new SummaryGeneration.SourcePage(r.getInt(1), r.getString(2))).list();
  }

  /** Called only inside JobCompletion's fenced transaction, after its job lock. */
  UUID save(UUID owner, UUID material, UUID job, SummaryGeneration.Result result) {
    lockOwner(owner);
    State state = state(owner, material, true);
    if (!"stored".equals(state.storage()) || !job.equals(state.jobId()) || !"succeeded".equals(state.extraction()))
      return material;
    long version = jdbc.sql("SELECT version FROM studymate.material_summaries WHERE material_id=:material FOR UPDATE")
        .param("material", material).query(Long.class).single() + 1;
    jdbc.sql("""
        INSERT INTO studymate.summary_versions(material_id,version,content,source_pages,origin,model,input_tokens,output_tokens)
        VALUES (:material,:version,:content,CAST(:sources AS jsonb),'ai',:model,:input,:output)
        """).param("material", material).param("version", version).param("content", result.content())
        .param("sources", json.writeValueAsString(result.sourcePages())).param("model", result.model())
        .param("input", result.inputTokens()).param("output", result.outputTokens()).update();
    jdbc.sql("UPDATE studymate.material_summaries SET version=:version,updated_at=clock_timestamp() WHERE material_id=:material")
        .param("version", version).param("material", material).update();
    return material;
  }

  @Transactional(timeout = 10)
  public View edit(UUID owner, UUID material, long expectedVersion, String content) {
    lockOwner(owner);
    State state = state(owner, material, true);
    if (!"stored".equals(state.storage())) throw unavailable();
    if ("queued".equals(state.jobStatus()) || "running".equals(state.jobStatus()))
      throw error(HttpStatus.CONFLICT, "SUMMARY_IN_PROGRESS", "Дождись окончания генерации перед редактированием.");
    long version = jdbc.sql("SELECT version FROM studymate.material_summaries WHERE material_id=:material FOR UPDATE")
        .param("material", material).query(Long.class).optional()
        .orElseThrow(() -> error(HttpStatus.NOT_FOUND, "SUMMARY_NOT_FOUND", "Конспект ещё не создан."));
    if (version == 0) throw error(HttpStatus.NOT_FOUND, "SUMMARY_NOT_FOUND", "Конспект ещё не создан.");
    if (version != expectedVersion) throw error(HttpStatus.CONFLICT, "SUMMARY_VERSION_CONFLICT", "Конспект уже изменён. Загрузи актуальную версию.");
    long next = version + 1;
    jdbc.sql("""
        INSERT INTO studymate.summary_versions(material_id,version,content,source_pages,origin)
        VALUES (:material,:version,:content,'[]'::jsonb,'user')
        """).param("material", material).param("version", next).param("content", content).update();
    jdbc.sql("UPDATE studymate.material_summaries SET version=:version,updated_at=clock_timestamp() WHERE material_id=:material")
        .param("version", next).param("material", material).update();
    return get(owner, material);
  }

  private State state(UUID owner, UUID material, boolean lock) {
    return jdbc.sql("""
        SELECT o.state, extracted.status AS extraction,m.summary_job_id,summary_job.status AS summary_status
        FROM studymate.materials m
        JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
        LEFT JOIN studymate.jobs extracted ON extracted.id=m.processing_job_id AND extracted.owner_id=m.owner_id
        LEFT JOIN studymate.jobs summary_job ON summary_job.id=m.summary_job_id AND summary_job.owner_id=m.owner_id
        WHERE m.owner_id=:owner AND m.id=:material
        """ + (lock ? " FOR UPDATE OF o,m" : ""))
        .param("owner", owner).param("material", material)
        .query((r, n) -> new State(r.getString("state"), r.getString("extraction"),
            r.getObject("summary_job_id", UUID.class), r.getString("summary_status")))
        .optional().orElseThrow(SummaryRepository::notFound);
  }

  private void lockOwner(UUID owner) {
    jdbc.sql("SELECT id FROM studymate.users WHERE id=:owner FOR UPDATE").param("owner", owner).query(UUID.class).single();
  }
  private static Instant instant(ResultSet r, String field) throws SQLException {
    var value = r.getTimestamp(field); return value == null ? null : value.toInstant();
  }
  private static ApiException notFound() { return error(HttpStatus.NOT_FOUND, "MATERIAL_NOT_FOUND", "Материал не найден."); }
  private static ApiException unavailable() { return error(HttpStatus.CONFLICT, "MATERIAL_NOT_AVAILABLE", "Материал недоступен."); }
  private static ApiException error(HttpStatus status, String code, String message) {
    return new ApiException(status, code, message, Map.of());
  }
}
