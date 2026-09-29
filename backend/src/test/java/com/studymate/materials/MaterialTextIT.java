package com.studymate.materials;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.studymate.PostgresIntegrationTest;
import com.studymate.common.api.ApiException;
import com.studymate.identity.AuthHttpClient;
import com.studymate.jobs.*;
import com.studymate.materials.pdf.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockPart;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties={"studymate.registration.enabled=true","server.servlet.session.cookie.secure=false"})
@Import({MaterialJobTestDriver.class,MaterialTextHandler.class,MaterialCleanupHandler.class})
class MaterialTextIT extends PostgresIntegrationTest {
  @Value("${local.server.port}") int port;
  @Autowired MaterialRepository materials;
  @Autowired MaterialTextRepository texts;
  @Autowired MaterialService service;
  @Autowired MaterialTextHandler handler;
  @Autowired MaterialCleanupHandler cleanup;
  @Autowired MaterialJobTestDriver driver;
  @Autowired JobQueue queue;
  @Autowired JdbcTemplate jdbc;
  @Autowired JsonMapper json;
  @MockitoBean ObjectStorage storage;
  private byte[] pdf;
  @BeforeEach void configure() throws Exception {
    pdf=PdfFixtures.text("Лекция 1","","Last page 3");
    when(storage.enabled()).thenReturn(true);
    doAnswer(call -> {
      assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
      Files.write((Path)call.getArgument(1),pdf); return null;
    }).when(storage).fetch(anyString(),any(),anyLong(),anyString());
  }
  @Test void uploadEnqueuesOnceAndPagesArePrivatePaginatedAndDurable() throws Exception {
    try(var owner=account(); var other=account(); var guest=new AuthHttpClient(port)) {
      var item=upload(owner); UUID id=item.id(),job=item.processingJobId();
      assertThat(item.processingStatus()).isEqualTo("queued"); assertThat(item.pageCount()).isNull();
      var original=materials.object(owner.id,id,false);
      UUID key=jdbc.queryForObject("SELECT request_key FROM studymate.material_objects WHERE id=?",UUID.class,id);
      String first=jdbc.queryForObject("SELECT response_body FROM studymate.material_objects WHERE id=?",String.class,id);
      assertThat(service.upload(owner.id,key,input(item.subjectId())).body()).isEqualTo(first);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.jobs WHERE owner_id=? AND kind=?",Integer.class,owner.id,handler.kind())).isEqualTo(1);
      assertThat(owner.http.error(owner.http.send("GET","/materials/"+id+"/pages",null,null),409)).isEqualTo("TEXT_NOT_READY");
      assertThat(other.http.error(other.http.send("GET","/materials/"+id+"/pages",null,null),404)).isEqualTo("MATERIAL_NOT_FOUND");
      assertThat(guest.error(guest.send("GET","/materials/"+id+"/pages",null,null),401)).isEqualTo("AUTHENTICATION_REQUIRED");
      var lease=driver.claim(job,handler.kind());
      assertThat(materials.get(owner.id,id).processingStatus()).isEqualTo("running");
      assertThat(driver.finish(lease,handler.execute(lease))).isTrue();
      var ready=materials.get(owner.id,id); assertThat(ready.processingStatus()).isEqualTo("ready");
      assertThat(ready.pageCount()).isEqualTo(3); assertThat(ready.textCharacters()).isGreaterThan(10);
      assertThat(ready.version()).isEqualTo(1); assertThat(ready.processingError()).isNull();
      var second=owner.http.send("GET","/materials/"+id+"/pages?page=2&pageSize=1",null,null);
      var page=owner.http.data(second,200); assertThat(page).hasSize(1);
      assertThat(page.get(0).get("pageNumber").asInt()).isEqualTo(2); assertThat(page.get(0).get("text").asString()).isEmpty();
      assertThat(json.readTree(second.body()).at("/meta/total").asInt()).isEqualTo(3);
      assertThat(owner.http.data(owner.http.send("GET","/materials/"+id+"/pages?page=9007199254740991",null,null),200)).isEmpty();
      for(String query:List.of("page=0","pageSize=101","q=x","page=1&page=2","ownerId=x"))
        assertThat(owner.http.send("GET","/materials/"+id+"/pages?"+query,null,null).statusCode()).isEqualTo(400);
      assertThat(owner.http.data(owner.http.send("GET","/jobs/"+job,null,null),200).get("resultId").asString()).isEqualTo(id.toString());
      // Upload replay keeps its original queued response after successful processing.
      assertThat(service.upload(owner.id,key,input(item.subjectId())).body()).isEqualTo(first);
      assertThat(materials.object(owner.id,id,false).objectKey()).isEqualTo(original.objectKey());
      var deletion=materials.delete(owner.id,id); driver.run(deletion.jobId(),cleanup);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.material_pages WHERE material_id=?",Integer.class,id)).isZero();
      assertThat(materials.usage(owner.id).usedBytes()).isZero();
    }
  }
  @Test void processRequiresCsrfOwnerIdempotencyAndSupportsOldMaterialsAndRetry() throws Exception {
    try(var owner=account(); var other=account()) {
      var item=upload(owner); UUID id=item.id();
      assertThat(owner.http.error(process(owner,id,null,null,null),403)).isEqualTo("CSRF_INVALID");
      assertThat(owner.http.error(process(owner,id,null,owner.http.token,null),400)).isEqualTo("IDEMPOTENCY_KEY_REQUIRED");
      assertThat(owner.http.error(process(owner,id,UUID.randomUUID(),owner.http.token,"{}"),400)).isEqualTo("INVALID_REQUEST");
      assertThat(other.http.error(process(other,id,UUID.randomUUID(),other.http.token,null),404)).isEqualTo("MATERIAL_NOT_FOUND");
      assertThat(owner.http.error(process(owner,id,UUID.randomUUID(),owner.http.token,null),409)).isEqualTo("PROCESSING_IN_PROGRESS");
      // Explicitly simulate a pre-V8 stored material without automatically backfilling a job.
      queue.cancel(owner.id,item.processingJobId());
      jdbc.update("UPDATE studymate.materials SET processing_job_id=NULL WHERE id=?",id);
      assertThat(materials.get(owner.id,id).processingStatus()).isEqualTo("not_started");
      UUID key=UUID.randomUUID();
      var response=owner.http.data(process(owner,id,key,owner.http.token,null),202);
      assertThat(owner.http.data(process(owner,id,key,owner.http.token,null),202)).isEqualTo(response);
      UUID first=UUID.fromString(response.get("jobId").asString());
      pdf=PdfFixtures.text(""); driver.run(first,handler);
      var failed=materials.get(owner.id,id); assertThat(failed.processingStatus()).isEqualTo("failed");
      assertThat(failed.processingError().code()).isEqualTo("PDF_NO_TEXT"); assertThat(failed.status()).isEqualTo("stored");
      assertThat(materials.usage(owner.id).usedBytes()).isEqualTo(item.sizeBytes());
      assertThat(owner.http.data(process(owner,id,key,owner.http.token,null),202)).isEqualTo(response);
      UUID retry=UUID.fromString(owner.http.data(process(owner,id,UUID.randomUUID(),owner.http.token,null),202).get("jobId").asString());
      assertThat(retry).isNotEqualTo(first); pdf=PdfFixtures.text("Recovered text"); driver.run(retry,handler);
      assertThat(owner.http.error(process(owner,id,UUID.randomUUID(),owner.http.token,null),409)).isEqualTo("TEXT_ALREADY_EXTRACTED");
      var second=upload(owner);
      assertThat(owner.http.error(process(owner,second.id(),key,owner.http.token,null),409)).isEqualTo("IDEMPOTENCY_KEY_REUSED");
      when(storage.enabled()).thenReturn(false);
      assertThat(owner.http.error(process(owner,id,key,owner.http.token,null),503)).isEqualTo("STORAGE_UNAVAILABLE");
      assertThat(owner.http.data(owner.http.send("GET","/materials/"+id+"/pages",null,null),200)).hasSize(1);
    }
  }
  @Test void deterministicFailureDoesNotRetryAndTemporaryStorageFailureDoes() throws Exception {
    try(var owner=account()) {
      for(String mode:List.of("integrity","temporary","encrypted")) {
        var item=upload(owner); UUID job=item.processingJobId();
        if(mode.equals("integrity")) doThrow(new ObjectIntegrityFailure()).when(storage).fetch(anyString(),any(),anyLong(),anyString());
        if(mode.equals("temporary")) doThrow(new StorageFailure()).when(storage).fetch(anyString(),any(),anyLong(),anyString());
        if(mode.equals("encrypted")) { configure(); pdf=PdfFixtures.encrypted(""); }
        driver.run(job,handler);
        var result=materials.get(owner.id,item.id());
        assertThat(result.status()).isEqualTo("stored"); assertThat(result.pageCount()).isNull();
        if(mode.equals("temporary")) {
          assertThat(result.processingStatus()).isEqualTo("queued");
          jdbc.update("UPDATE studymate.jobs SET max_attempts=2 WHERE id=?",job);
          driver.run(job,handler);
          assertThat(materials.get(owner.id,item.id()).processingStatus()).isEqualTo("failed");
        } else {
          assertThat(result.processingStatus()).isEqualTo("failed");
          assertThat(result.processingError().code()).isEqualTo(mode.equals("integrity")?"PDF_ORIGINAL_MISMATCH":"PDF_ENCRYPTED");
        }
        assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.material_pages WHERE material_id=?",Integer.class,item.id())).isZero();
      }
    }
  }
  @Test void deletionCancelsRunningParserAndFencesItsLateResult() throws Exception {
    try(var owner=account()) {
      var item=upload(owner); var lease=driver.claim(item.processingJobId(),handler.kind());
      var outcome=handler.execute(lease);
      var deletion=materials.delete(owner.id,item.id());
      assertThat(materials.get(owner.id,item.id()).processingStatus()).isEqualTo("cancelled");
      assertThat(driver.finish(lease,outcome)).isFalse();
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.material_pages WHERE material_id=?",Integer.class,item.id())).isZero();
      driver.run(deletion.jobId(),cleanup);
      assertThat(driver.finish(lease,outcome)).isFalse();
      assertThatThrownBy(() -> materials.get(owner.id,item.id())).isInstanceOf(ApiException.class);
    }
  }
  @Test void callbackRollsBackAllPagesOnFailureAndExpiredLeaseCannotPublish() throws Exception {
    try(var owner=account()) {
      var item=upload(owner); var lease=driver.claim(item.processingJobId(),handler.kind());
      var parsed=(JobOutcome.Succeeded)handler.execute(lease);
      assertThatThrownBy(() -> driver.finish(lease,new JobOutcome.Succeeded(() -> {
        parsed.completion().persist(); throw new IllegalStateException("test-only rollback");
      }))).isInstanceOf(IllegalStateException.class);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.material_pages WHERE material_id=?",Integer.class,item.id())).isZero();
      assertThat(materials.get(owner.id,item.id()).pageCount()).isNull();
      jdbc.update("UPDATE studymate.jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=?",item.processingJobId());
      assertThat(driver.finish(lease,parsed)).isFalse(); driver.recover();
      driver.run(item.processingJobId(),handler);
      assertThat(texts.pages(owner.id,item.id(),1,100).data()).hasSize(3);
    }
  }
  @Test void completionAndDeleteUseSameLockOrderUnderConcurrency() throws Exception {
    try(var owner=account(); var pool=Executors.newFixedThreadPool(2)) {
      var item=upload(owner); var lease=driver.claim(item.processingJobId(),handler.kind()); var outcome=handler.execute(lease);
      var gate=new CountDownLatch(1);
      var finish=pool.submit(() -> { gate.await(); return driver.finish(lease,outcome); });
      var delete=pool.submit(() -> { gate.await(); return materials.delete(owner.id,item.id()); });
      gate.countDown(); finish.get(10,TimeUnit.SECONDS); driver.run(delete.get(10,TimeUnit.SECONDS).jobId(),cleanup);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.material_pages WHERE material_id=?",Integer.class,item.id())).isZero();
    }
  }
  private record Account(UUID id,AuthHttpClient http) implements AutoCloseable { public void close() { http.close(); } }
  private Account account() throws Exception {
    var client=new AuthHttpClient(port); String email="pdf-"+UUID.randomUUID()+"@example.com";
    UUID id=UUID.fromString(client.register(email)); client.data(client.login(email),200); client.csrf(); return new Account(id,client);
  }
  private MaterialResponse upload(Account owner) throws Exception {
    UUID subject=UUID.fromString(owner.http.data(owner.http.send("POST","/subjects",Map.of("title","Test "+UUID.randomUUID(),"icon","book","tone","blue"),owner.http.token,
        Map.of("Idempotency-Key",UUID.randomUUID().toString())),201).get("id").asString());
    var result=service.upload(owner.id,UUID.randomUUID(),input(subject)); return materials.get(owner.id,result.id());
  }
  private MaterialInput input(UUID subject) throws Exception {
    return new MaterialInput(subject,"Title","fixture.pdf",pdf.length,HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pdf)),new MockPart("file","fixture.pdf",pdf));
  }
  private java.net.http.HttpResponse<String> process(Account owner,UUID id,UUID key,String csrf,String body) throws Exception {
    return owner.http.send("POST","/materials/"+id+"/process",body,csrf,key==null?Map.of():Map.of("Idempotency-Key",key.toString()));
  }
}
