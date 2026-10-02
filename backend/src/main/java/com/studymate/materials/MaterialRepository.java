package com.studymate.materials;

import com.studymate.common.api.ApiException;
import com.studymate.common.api.ApiResponse;
import com.studymate.common.validation.TextInput;
import com.studymate.jobs.JobQueue;
import com.studymate.jobs.RetryPolicy;
import com.studymate.jobs.JobError;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

@Repository
class MaterialRepository {
  static final String CLEANUP_KIND = "material.delete";
  private final JdbcClient jdbc;
  private final JobQueue jobs;
  private final JsonMapper json;
  MaterialRepository(JdbcClient jdbc, JobQueue jobs, JsonMapper json) { this.jdbc = jdbc; this.jobs = jobs; this.json = json; }

  record Reservation(UUID id, String objectKey, String response) {}
  record StoredObject(UUID id, UUID owner, String objectKey, String state, UUID jobId, boolean ready) {
    @Override public String toString() { return "StoredObject[redacted]"; }
  }
  record Usage(long usedBytes, long reservedBytes, long limitBytes, long maxUploadBytes) {}
  record Page(List<MaterialResponse> data, Meta meta) {}
  record Meta(long page, int pageSize, long total) {}
  record Deletion(UUID materialId, UUID jobId) {}

  @Transactional(timeout = 10)
  public Reservation reserve(UUID owner, UUID key, MaterialInput input, String fingerprint) {
    lockOwner(owner);
    var old = jdbc.sql("SELECT id, object_key, fingerprint, state, response_body FROM studymate.material_objects WHERE owner_id=:owner AND request_key=:key")
        .param("owner",owner).param("key",key).query((r,n) -> {
          if (!r.getString("fingerprint").equals(fingerprint)) throw MaterialInput.error(HttpStatus.CONFLICT,"IDEMPOTENCY_KEY_REUSED","Ключ уже использован для другой загрузки.");
          return switch (r.getString("state")) {
            case "stored" -> new Reservation(r.getObject("id",UUID.class), r.getString("object_key"), r.getString("response_body"));
            case "uploading" -> throw new ApiException(HttpStatus.CONFLICT,"REQUEST_IN_PROGRESS","Загрузка ещё выполняется.",Map.of(),2);
            default -> throw MaterialInput.error(HttpStatus.GONE,"UPLOAD_ABORTED","Материал удалён или загрузка отменена. Обнови список и квоту.");
          };
        }).optional();
    if (old.isPresent()) return old.get();
    // KEY SHARE synchronizes with subject DELETE; the composite FK also enforces ownership in SQL.
    requireSubject(owner, input.subjectId(), true);
    Usage usage = usage(owner);
    if (input.sizeBytes() > MaterialLimits.ACCOUNT_BYTES - usage.usedBytes() - usage.reservedBytes())
      throw MaterialInput.error(HttpStatus.CONFLICT,"STORAGE_QUOTA_EXCEEDED","Недостаточно места: лимит аккаунта 524 288 000 байт.");
    UUID id = UUID.randomUUID();
    String objectKey = "originals/" + owner + "/" + id + ".pdf";
    jdbc.sql("""
        INSERT INTO studymate.material_objects(id,owner_id,request_key,fingerprint,object_key,size_bytes,sha256)
        VALUES (:id,:owner,:key,:fingerprint,:objectKey,:bytes,:sha)
        """).param("id",id).param("owner",owner).param("key",key).param("fingerprint",fingerprint)
        .param("objectKey",objectKey).param("bytes",input.sizeBytes()).param("sha",input.sha256()).update();
    jdbc.sql("""
        INSERT INTO studymate.materials(id,owner_id,subject_id,title,normalized_title,file_name)
        VALUES (:id,:owner,:subject,:title,:normalized,:name)
        """).param("id",id).param("owner",owner).param("subject",input.subjectId()).param("title",input.title())
        .param("normalized",TextInput.searchKey(input.title())).param("name",input.fileName()).update();
    return new Reservation(id, objectKey, null);
  }

  @Transactional(timeout = 10)
  public String stored(UUID owner, UUID id) {
    lockOwner(owner);
    var current = object(owner,id,true);
    if (!current.state().equals("uploading")) throw MaterialInput.error(HttpStatus.CONFLICT,"UPLOAD_ABORTED","Загрузка уже отменена.");
    // The same DB deadline is checked at publication, not merely before an external PUT.
    int changed = jdbc.sql("""
        UPDATE studymate.material_objects SET state='stored',accounting='used',response_body='{}',
          cleanup_not_before=clock_timestamp(),updated_at=clock_timestamp()
        WHERE owner_id=:owner AND id=:id AND upload_expires_at > clock_timestamp()
        """).param("owner",owner).param("id",id).update();
    if (changed != 1) throw MaterialInput.error(HttpStatus.CONFLICT,"UPLOAD_ABORTED","Срок загрузки истёк.");
    UUID processing=jobs.enqueue(owner,MaterialTextRepository.KIND,id,json.valueToTree(Map.of("materialId",id)),RetryPolicy.SAFE);
    jdbc.sql("UPDATE studymate.materials SET processing_job_id=:job WHERE id=:id AND owner_id=:owner")
        .param("job",processing).param("id",id).param("owner",owner).update();
    String body = json.writeValueAsString(new ApiResponse<>(get(owner,id)));
    jdbc.sql("UPDATE studymate.material_objects SET response_body=:body WHERE id=:id AND owner_id=:owner")
        .param("body",body).param("id",id).param("owner",owner).update();
    return body;
  }

  Usage usage(UUID owner) {
    return jdbc.sql("""
        SELECT coalesce(sum(size_bytes) FILTER (WHERE accounting='used'),0) AS used,
          coalesce(sum(size_bytes) FILTER (WHERE accounting='reserved'),0) AS reserved
        FROM studymate.material_objects WHERE owner_id=:owner AND accounting <> 'released'
        """).param("owner",owner).query((r,n) -> new Usage(r.getLong("used"),r.getLong("reserved"),
          MaterialLimits.ACCOUNT_BYTES,MaterialLimits.MAX_UPLOAD_BYTES)).single();
  }

  private static final String PROJECTION = """
      SELECT m.id, m.owner_id, m.subject_id, m.title, m.file_name, m.version, m.created_at,
        greatest(m.updated_at,o.updated_at,j.updated_at) AS updated_at, o.size_bytes, o.state, o.cleanup_job_id,
        m.processing_job_id,m.page_count,m.text_characters,j.status AS job_status,j.error_code
      FROM studymate.materials m JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
      LEFT JOIN studymate.jobs j ON j.id=m.processing_job_id AND j.owner_id=m.owner_id
      """;
  MaterialResponse get(UUID owner, UUID id) {
    return jdbc.sql(PROJECTION + " WHERE m.owner_id=:owner AND m.id=:id")
        .param("owner",owner).param("id",id).query((r,n) -> response(r)).optional().orElseThrow(MaterialRepository::notFound);
  }

  Page list(UUID owner, MaterialQuery query) {
    if (query.subjectId() != null) requireSubject(owner,query.subjectId(),false);
    record Row(MaterialResponse item,long total) {}
    var rows = jdbc.sql("WITH filtered AS (" + PROJECTION + """
         WHERE m.owner_id=:owner AND (cast(:subject AS uuid) IS NULL OR m.subject_id=:subject)
           AND (:q='' OR strpos(m.normalized_title,:q)>0)
        ), page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT :limit OFFSET :offset)
        SELECT page.*,totals.total FROM (SELECT count(*) AS total FROM filtered) totals
        LEFT JOIN page ON TRUE ORDER BY page.created_at DESC,page.id DESC
        """).param("owner",owner).param("subject",query.subjectId()).param("q",query.q())
        .param("limit",query.pageSize()).param("offset",(query.page()-1)*query.pageSize())
        .query((r,n) -> new Row(r.getObject("id") == null ? null : response(r),r.getLong("total"))).list();
    return new Page(rows.stream().map(Row::item).filter(java.util.Objects::nonNull).toList(),new Meta(query.page(),query.pageSize(),rows.getFirst().total()));
  }

  @Transactional(timeout = 10)
  public MaterialResponse rename(UUID owner, UUID id, String title, long version) {
    lockOwner(owner);
    var object = object(owner,id,true);
    if (object.state().equals("deleted")) throw notFound();
    if (!object.state().equals("stored")) throw MaterialInput.error(HttpStatus.CONFLICT,"MATERIAL_NOT_AVAILABLE","Материал пока недоступен для изменения.");
    int changed = jdbc.sql("""
        UPDATE studymate.materials SET title=:title,normalized_title=:key,version=version+1,updated_at=clock_timestamp()
        WHERE owner_id=:owner AND id=:id AND version=:version
        """).param("owner",owner).param("id",id).param("title",title).param("key",TextInput.searchKey(title)).param("version",version).update();
    if (changed != 1) throw MaterialInput.error(HttpStatus.CONFLICT,"MATERIAL_VERSION_CONFLICT","Материал уже изменён. Загрузи актуальные данные.");
    return get(owner,id);
  }

  @Transactional(timeout = 10)
  public Deletion delete(UUID owner, UUID id) {
    // Completion locks its job before owner/object. Lock all current jobs before revoking any.
    UUID processing=processingJob(owner,id), summary=summaryJob(owner,id), quiz=quizJob(owner,id);
    var toLock=new java.util.ArrayList<UUID>();
    if(processing!=null) toLock.add(processing);
    if(summary!=null && !summary.equals(processing)) toLock.add(summary);
    if(quiz!=null && !toLock.contains(quiz)) toLock.add(quiz);
    toLock.sort(UUID::compareTo);
    for(UUID jobId:toLock) jdbc.sql("SELECT id FROM studymate.jobs WHERE owner_id=:owner AND id=:job FOR UPDATE")
        .param("owner",owner).param("job",jobId).query(UUID.class).single();
    lockOwner(owner);
    var object = object(owner,id,true);
    if (object.state().equals("deleted")) throw notFound();
    if(!java.util.Objects.equals(processing,processingJob(owner,id)) || !java.util.Objects.equals(summary,summaryJob(owner,id))
        || !java.util.Objects.equals(quiz,quizJob(owner,id)))
      throw new ApiException(HttpStatus.CONFLICT,"REQUEST_IN_PROGRESS","Обработка только что изменилась. Повтори удаление.",Map.of(),1);
    if(processing!=null) jobs.cancel(owner,processing);
    if(summary!=null) jobs.cancel(owner,summary);
    if(quiz!=null) jobs.cancel(owner,quiz);
    if (object.jobId() != null) {
      String status = jdbc.sql("SELECT status FROM studymate.jobs WHERE id=:id AND owner_id=:owner")
          .param("id",object.jobId()).param("owner",owner).query(String.class).single();
      if (status.equals("queued") || status.equals("running")) return new Deletion(id,object.jobId());
    }
    UUID job = jobs.enqueue(owner,CLEANUP_KIND,UUID.randomUUID(),json.valueToTree(Map.of("materialId",id)),RetryPolicy.SAFE);
    jdbc.sql("""
        UPDATE studymate.material_objects SET state='deleting',cleanup_job_id=:job,updated_at=clock_timestamp()
        WHERE owner_id=:owner AND id=:id
        """).param("job",job).param("owner",owner).param("id",id).update();
    // A new job is invisible until this transaction commits. It must not exhaust attempts while PUT can still be in flight.
    jdbc.sql("""
        UPDATE studymate.jobs SET next_attempt_at=greatest(next_attempt_at,
          (SELECT cleanup_not_before FROM studymate.material_objects WHERE id=:id)) WHERE id=:job
        """).param("id",id).param("job",job).update();
    return new Deletion(id,job);
  }

  StoredObject object(UUID owner, UUID id, boolean lock) {
    return jdbc.sql("""
        SELECT id,owner_id,object_key,state,cleanup_job_id,cleanup_not_before <= clock_timestamp() AS ready
        FROM studymate.material_objects WHERE owner_id=:owner AND id=:id
        """ + (lock ? " FOR UPDATE" : "")).param("owner",owner).param("id",id)
        .query((r,n) -> new StoredObject(id,owner,r.getString("object_key"),r.getString("state"),
            r.getObject("cleanup_job_id",UUID.class),r.getBoolean("ready"))).optional().orElseThrow(MaterialRepository::notFound);
  }

  /** Invoked inside JobCompletion's fenced transaction. Lock order: job, owner, object, material. */
  UUID finishCleanup(UUID owner, UUID id, UUID job) {
    lockOwner(owner);
    var current = object(owner,id,true);
    if (!current.state().equals("deleting") || !job.equals(current.jobId())) return id;
    jdbc.sql("DELETE FROM studymate.materials WHERE owner_id=:owner AND id=:id")
        .param("owner",owner).param("id",id).update();
    jdbc.sql("""
        UPDATE studymate.material_objects SET state='deleted',accounting='released',response_body=NULL,
          audit_after=clock_timestamp()+INTERVAL '1 day',updated_at=clock_timestamp()
        WHERE owner_id=:owner AND id=:id
        """).param("owner",owner).param("id",id).update();
    return id;
  }

  List<StoredObject> expiredUploads() {
    return jdbc.sql("""
        SELECT id,owner_id,object_key,state,cleanup_job_id FROM studymate.material_objects
        WHERE state='uploading' AND upload_expires_at <= clock_timestamp() ORDER BY upload_expires_at,id LIMIT 20
        """).query((r,n) -> new StoredObject(r.getObject("id",UUID.class),r.getObject("owner_id",UUID.class),
          r.getString("object_key"),r.getString("state"),null,true)).list();
  }

  @Transactional(timeout = 10)
  public void expire(UUID owner, UUID id) {
    lockOwner(owner);
    var current = object(owner,id,true);
    if (current.state().equals("uploading") && jdbc.sql("SELECT upload_expires_at <= clock_timestamp() FROM studymate.material_objects WHERE id=:id")
        .param("id",id).query(Boolean.class).single()) delete(owner,id);
  }

  // Claim one tombstone per minute/process. Keys are retained even after confirmed deletion because remote writes can finish late.
  @Transactional(timeout = 10)
  public String claimAudit() {
    return jdbc.sql("""
        WITH candidate AS (SELECT id FROM studymate.material_objects WHERE state='deleted' AND audit_after<=clock_timestamp()
          ORDER BY audit_after,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE studymate.material_objects o SET audit_after=clock_timestamp()+INTERVAL '1 day'
        FROM candidate c WHERE o.id=c.id RETURNING o.object_key
        """).query(String.class).optional().orElse(null);
  }

  private void lockOwner(UUID owner) {
    jdbc.sql("SELECT id FROM studymate.users WHERE id=:owner FOR UPDATE").param("owner",owner).query(UUID.class).single();
  }
  private UUID processingJob(UUID owner,UUID id) {
    return jdbc.sql("SELECT processing_job_id FROM studymate.materials WHERE owner_id=:owner AND id=:id")
        .param("owner",owner).param("id",id).query((r,n) -> r.getObject(1,UUID.class)).optional().orElse(null);
  }
  private UUID summaryJob(UUID owner,UUID id) {
    return jdbc.sql("SELECT summary_job_id FROM studymate.materials WHERE owner_id=:owner AND id=:id")
        .param("owner",owner).param("id",id).query((r,n) -> r.getObject(1,UUID.class)).optional().orElse(null);
  }
  private UUID quizJob(UUID owner,UUID id) {
    return jdbc.sql("SELECT quiz_job_id FROM studymate.materials WHERE owner_id=:owner AND id=:id")
        .param("owner",owner).param("id",id).query((r,n) -> r.getObject(1,UUID.class)).optional().orElse(null);
  }
  private void requireSubject(UUID owner, UUID id, boolean lock) {
    if (jdbc.sql("SELECT id FROM studymate.subjects WHERE owner_id=:owner AND id=:id" + (lock ? " FOR KEY SHARE" : ""))
        .param("owner",owner).param("id",id).query(UUID.class).optional().isEmpty())
      throw MaterialInput.error(HttpStatus.NOT_FOUND,"SUBJECT_NOT_FOUND","Предмет не найден.");
  }
  static ApiException notFound() { return MaterialInput.error(HttpStatus.NOT_FOUND,"MATERIAL_NOT_FOUND","Материал не найден."); }
  private static MaterialResponse response(ResultSet r) throws SQLException {
    String job=r.getString("job_status");
    String processing=job==null ? "not_started" : job.equals("succeeded") ? "ready" : job;
    JobError error="failed".equals(job) ? JobError.valueOf(r.getString("error_code")) : null;
    return new MaterialResponse(r.getObject("id",UUID.class),r.getObject("subject_id",UUID.class),r.getString("title"),
        r.getString("file_name"),"application/pdf",r.getLong("size_bytes"),r.getString("state"),processing,
        r.getLong("version"),r.getTimestamp("created_at").toInstant(),r.getTimestamp("updated_at").toInstant(),r.getObject("cleanup_job_id",UUID.class),
        r.getObject("processing_job_id",UUID.class),r.getObject("page_count",Integer.class),r.getObject("text_characters",Integer.class),
        error==null ? null : new MaterialResponse.ProcessingError(error.name(),error.message()));
  }
}
