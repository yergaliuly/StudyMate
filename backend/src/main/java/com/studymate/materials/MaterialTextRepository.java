package com.studymate.materials;

import com.studymate.jobs.*;
import com.studymate.materials.pdf.PdfResult;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

@Repository
class MaterialTextRepository {
  static final String KIND="material.extract_text";
  private final JdbcClient jdbc;
  private final JobQueue queue;
  private final JsonMapper json;
  MaterialTextRepository(JdbcClient jdbc,JobQueue queue,JsonMapper json) { this.jdbc=jdbc; this.queue=queue; this.json=json; }
  record Original(String key,long bytes,String sha256,UUID job) { @Override public String toString() { return "Original[redacted]"; } }
  Optional<Original> original(UUID owner,UUID id,boolean lock) {
    return jdbc.sql("""
        SELECT o.object_key,o.size_bytes,o.sha256,m.processing_job_id FROM studymate.materials m
        JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
        WHERE m.owner_id=:owner AND m.id=:id AND o.state='stored'
        """+(lock?" FOR UPDATE OF o,m":"")).param("owner",owner).param("id",id)
        .query((r,n) -> new Original(r.getString(1),r.getLong(2),r.getString(3),r.getObject(4,UUID.class))).optional();
  }
  record Processing(UUID materialId,UUID jobId) {}
  @Transactional(timeout=10)
  public Processing start(UUID owner,UUID id,UUID key) {
    jdbc.sql("SELECT id FROM studymate.users WHERE id=:owner FOR UPDATE").param("owner",owner).query(UUID.class).single();
    var current=original(owner,id,true).orElseThrow(() -> {
      boolean exists=jdbc.sql("SELECT EXISTS(SELECT 1 FROM studymate.materials WHERE owner_id=:owner AND id=:id)")
          .param("owner",owner).param("id",id).query(Boolean.class).single();
      return exists ? MaterialInput.error(HttpStatus.CONFLICT,"MATERIAL_NOT_AVAILABLE","Дождись загрузки или завершения удаления.") : MaterialRepository.notFound();
    });
    // A repeated request key always returns the same operation, including terminal states.
    var existing=jdbc.sql("SELECT id,payload=cast(:payload AS jsonb) AS matches FROM studymate.jobs WHERE owner_id=:owner AND kind=:kind AND operation_key=:key")
        .param("owner",owner).param("kind",KIND).param("key",key).param("payload",json.writeValueAsString(Map.of("materialId",id)))
        .query((r,n) -> {
          if(!r.getBoolean(2)) throw MaterialInput.error(HttpStatus.CONFLICT,"IDEMPOTENCY_KEY_REUSED","Ключ уже использован для другого материала.");
          return r.getObject(1,UUID.class);
        }).optional();
    if(existing.isPresent()) return new Processing(id,existing.get());
    if(current.job()!=null) {
      String status=jdbc.sql("SELECT status FROM studymate.jobs WHERE owner_id=:owner AND id=:job")
          .param("owner",owner).param("job",current.job()).query(String.class).single();
      if(status.equals("queued") || status.equals("running"))
        throw new com.studymate.common.api.ApiException(HttpStatus.CONFLICT,"PROCESSING_IN_PROGRESS","У материала уже есть активное задание.",Map.of(),2);
      if(status.equals("succeeded")) throw MaterialInput.error(HttpStatus.CONFLICT,"TEXT_ALREADY_EXTRACTED","Текст уже сохранён.");
    }
    UUID job=queue.enqueue(owner,KIND,key,json.valueToTree(Map.of("materialId",id)),RetryPolicy.SAFE);
    jdbc.sql("UPDATE studymate.materials SET processing_job_id=:job,updated_at=clock_timestamp() WHERE owner_id=:owner AND id=:id")
        .param("owner",owner).param("id",id).param("job",job).update();
    return new Processing(id,job);
  }

  /** Only called from JobCompletion's fenced transaction; a DELETE locks/cancels that same job first. */
  UUID save(UUID owner,UUID id,UUID job,PdfResult result) {
    jdbc.sql("SELECT id FROM studymate.users WHERE id=:owner FOR UPDATE").param("owner",owner).query(UUID.class).single();
    var current=original(owner,id,true).orElseThrow(() -> new IllegalStateException("Material no longer available"));
    if(!job.equals(current.job()) || result.error()!=null || result.pages().isEmpty() || result.pages().size()>200
        || result.characters()>1_000_000 || result.characters()<1
        || result.pages().stream().anyMatch(p -> p.length()>100_000 || p.indexOf(0)>=0)) throw new IllegalStateException("Invalid PDF result");
    jdbc.sql("DELETE FROM studymate.material_pages WHERE material_id=:id").param("id",id).update();
    for(int i=0;i<result.pages().size();i++) jdbc.sql("INSERT INTO studymate.material_pages(material_id,page_number,text_content) VALUES (:id,:page,:text)")
        .param("id",id).param("page",i+1).param("text",result.pages().get(i)).update();
    jdbc.sql("UPDATE studymate.materials SET page_count=:pages,text_characters=:chars,updated_at=clock_timestamp() WHERE owner_id=:owner AND id=:id AND processing_job_id=:job")
        .param("pages",result.pages().size()).param("chars",result.characters()).param("owner",owner).param("id",id).param("job",job).update();
    return id;
  }
  record TextPage(int pageNumber,String text) {}
  record Pages(List<TextPage> data,MaterialRepository.Meta meta) {}
  Pages pages(UUID owner,UUID id,long page,int pageSize) {
    // One snapshot checks ownership, stored/ready state, page data and total; no race with deletion between SELECTs.
    var rows=jdbc.sql("""
        WITH ready AS (
          SELECT m.id,m.page_count,o.state,j.status FROM studymate.materials m
          JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
          LEFT JOIN studymate.jobs j ON j.id=m.processing_job_id AND j.owner_id=m.owner_id
          WHERE m.owner_id=:owner AND m.id=:id
        )
        SELECT r.page_count,r.state,r.status,p.page_number,p.text_content FROM ready r LEFT JOIN LATERAL (
          SELECT page_number,text_content FROM studymate.material_pages WHERE material_id=r.id
          AND r.state='stored' AND r.status='succeeded' ORDER BY page_number LIMIT :size OFFSET :offset
        ) p ON TRUE ORDER BY p.page_number
        """).param("owner",owner).param("id",id).param("size",pageSize).param("offset",(page-1)*pageSize)
        .query((r,n) -> {
          if(!r.getString("state").equals("stored")) throw MaterialInput.error(HttpStatus.CONFLICT,"MATERIAL_NOT_AVAILABLE","Материал недоступен.");
          if(!"succeeded".equals(r.getString("status"))) throw MaterialInput.error(HttpStatus.CONFLICT,"TEXT_NOT_READY","Текст ещё не готов.");
          return new TextRow(r.getObject("page_number")==null ? null : new TextPage(r.getInt("page_number"),r.getString("text_content")),r.getInt("page_count"));
        }).list();
    if(rows.isEmpty()) throw MaterialRepository.notFound();
    return new Pages(rows.stream().map(TextRow::page).filter(Objects::nonNull).toList(),new MaterialRepository.Meta(page,pageSize,rows.getFirst().total));
  }
  private record TextRow(TextPage page,int total) {}
}
