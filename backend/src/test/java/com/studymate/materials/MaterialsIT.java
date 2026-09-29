package com.studymate.materials;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.studymate.PostgresIntegrationTest;
import com.studymate.common.api.ApiException;
import com.studymate.identity.AuthHttpClient;
import com.studymate.jobs.MaterialJobTestDriver;
import com.studymate.jobs.JobOutcome;
import com.studymate.jobs.JobQueue;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties={"studymate.registration.enabled=true","server.servlet.session.cookie.secure=false"})
@Import({MaterialJobTestDriver.class, MaterialCleanupHandler.class})
class MaterialsIT extends PostgresIntegrationTest {
  @Value("${local.server.port}") int port;
  @Autowired MaterialRepository repository;
  @Autowired MaterialService service;
  @Autowired MaterialCleanupHandler handler;
  @Autowired MaterialJobTestDriver driver;
  @Autowired JobQueue queue;
  @Autowired JdbcTemplate jdbc;
  @Autowired JsonMapper json;
  @Autowired PlatformTransactionManager transactionManager;
  @MockitoBean ObjectStorage storage;
  final Map<String,byte[]> objects=new ConcurrentHashMap<>();
  final AtomicInteger puts=new AtomicInteger();

  @BeforeEach void configure() {
    when(storage.enabled()).thenReturn(true);
    doAnswer(call -> {
      puts.incrementAndGet();
      assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
      try(var stream=((Supplier<InputStream>)call.getArgument(3)).get()) { objects.put(call.getArgument(0),stream.readAllBytes()); }
      return null;
    }).when(storage).put(anyString(),anyLong(),anyString(),any());
    doAnswer(call -> { objects.remove(call.getArgument(0)); return null; }).when(storage).delete(anyString());
    when(storage.download(anyString())).thenReturn(new ObjectStorage.Download("https://test-only.invalid/signed",Instant.now().plusSeconds(60)));
  }

  @Test void httpLifecycleCountersVersionAndDeletionWithDependentHistory() throws Exception {
    try(var account=account(); var other=account()) {
      UUID subject=subject(account); UUID key=UUID.randomUUID();
      var response=upload(account,subject,key,null,MaterialInputTest.PDF,"Лекция.pdf",true,false);
      var material=account.data(response,201); UUID id=UUID.fromString(material.get("id").asString());
      assertThat(material.size()).isEqualTo(12);
      assertThat(material.get("title").asString()).isEqualTo("Лекция");
      assertThat(material.get("status").asString()).isEqualTo("stored");
      assertThat(material.get("processingStatus").asString()).isEqualTo("not_started");
      assertThat(material.get("deletionJobId").isNull()).isTrue();
      assertThat(response.headers().firstValue("Location")).hasValue("/api/v1/materials/"+id);
      assertThat(response.body()).doesNotContain("objectKey","ownerId","sha256","lease","password");
      assertThat(upload(account,subject,key," ",MaterialInputTest.PDF,"Лекция.pdf",true,false).body()).isEqualTo(response.body());
      assertThat(puts.get()).isEqualTo(1);
      assertThat(account.error(upload(account,subject,key,"Другое",MaterialInputTest.PDF,"Лекция.pdf",true,false),409)).isEqualTo("IDEMPOTENCY_KEY_REUSED");
      assertThat(subjectCount(account,subject)).isEqualTo(1);
      assertThat(account.data(account.send("GET","/subjects",null,null),200).get(0).get("lectureCount").asInt()).isEqualTo(1);
      var subjectPatch=account.data(account.send("PATCH","/subjects/"+subject,Map.of("version",1,"title","Новое имя предмета"),account.token),200);
      assertThat(subjectPatch.get("lectureCount").asInt()).isEqualTo(1);
      assertThat(account.error(account.send("DELETE","/subjects/"+subject,null,account.token),409)).isEqualTo("SUBJECT_NOT_EMPTY");
      assertThat(account.data(account.send("GET","/storage/usage",null,null),200).get("usedBytes").asLong()).isEqualTo(MaterialInputTest.PDF.length);
      var renamed=account.data(account.send("PATCH","/materials/"+id,Map.of("title"," НОВОЕ   имя ","version",1),account.token),200);
      assertThat(renamed.get("title").asString()).isEqualTo("НОВОЕ имя"); assertThat(renamed.get("version").asLong()).isEqualTo(2);
      assertThat(account.error(account.send("PATCH","/materials/"+id,Map.of("title","Lost update","version",1),account.token),409)).isEqualTo("MATERIAL_VERSION_CONFLICT");
      assertThat(account.data(account.send("GET","/materials?subjectId="+subject+"&q=%D0%BD%D0%BE%D0%B2%D0%BE%D0%B5&pageSize=1",null,null),200)).hasSize(1);
      assertThat(account.data(account.send("GET","/materials?page=999",null,null),200)).isEmpty();
      assertThat(account.data(account.send("GET","/materials/"+id+"/download",null,null),200).get("expiresAt")).isNotNull();
      for (String method:List.of("GET","PATCH","DELETE")) {
        var body=method.equals("PATCH") ? Map.of("title","Theirs","version",2) : null;
        assertThat(other.error(other.send(method,"/materials/"+id,body,other.token),404)).isEqualTo("MATERIAL_NOT_FOUND");
      }
      assertThat(other.error(other.send("GET","/materials/"+id+"/download",null,null),404)).isEqualTo("MATERIAL_NOT_FOUND");
      assertThat(other.data(other.send("GET","/materials",null,null),200)).isEmpty();
      assertThat(other.error(upload(other,subject,UUID.randomUUID(),null,MaterialInputTest.PDF,"a.pdf",true,false),404)).isEqualTo("SUBJECT_NOT_FOUND");
      // Stage 12 does not exist yet. Verify the agreed cascade contract with explicitly test-only dependent history.
      jdbc.execute("CREATE TABLE studymate.stage8_history_test(id UUID PRIMARY KEY,material_id UUID NOT NULL REFERENCES studymate.materials(id) ON DELETE CASCADE)");
      try {
        jdbc.update("INSERT INTO studymate.stage8_history_test VALUES (?,?)",UUID.randomUUID(),id);
        var deletion=account.data(account.send("DELETE","/materials/"+id,null,account.token),202);
        UUID job=UUID.fromString(deletion.get("jobId").asString());
        assertThat(account.data(account.send("DELETE","/materials/"+id,null,account.token),202)).isEqualTo(deletion);
        assertThat(subjectCount(account,subject)).isZero();
        assertThat(account.error(account.send("DELETE","/subjects/"+subject,null,account.token),409)).isEqualTo("SUBJECT_NOT_EMPTY");
        assertThat(account.error(account.send("GET","/materials/"+id+"/download",null,null),409)).isEqualTo("MATERIAL_NOT_AVAILABLE");
        assertThat(account.error(account.send("PATCH","/materials/"+id,Map.of("title","Late","version",2),account.token),409)).isEqualTo("MATERIAL_NOT_AVAILABLE");
        assertThat(usage(account).get("usedBytes").asLong()).isEqualTo(MaterialInputTest.PDF.length);
        driver.run(job,handler);
        assertThat(account.data(account.send("GET","/jobs/"+job,null,null),200).get("status").asString()).isEqualTo("succeeded");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.stage8_history_test",Integer.class)).isZero();
        assertThat(usage(account).get("usedBytes").asLong()).isZero(); assertThat(objects).isEmpty();
        assertThat(account.error(account.send("GET","/materials/"+id,null,null),404)).isEqualTo("MATERIAL_NOT_FOUND");
        assertThat(account.error(account.send("DELETE","/materials/"+id,null,account.token),404)).isEqualTo("MATERIAL_NOT_FOUND");
        assertThat(account.error(upload(account,subject,key,null,MaterialInputTest.PDF,"Лекция.pdf",true,false),410)).isEqualTo("UPLOAD_ABORTED");
        account.send("DELETE","/subjects/"+subject,null,account.token);
      } finally { jdbc.execute("DROP TABLE studymate.stage8_history_test"); }
    }
  }

  @Test void malformedMultipartAuthorizationCsrfAndActualSizeAreCheckedBeforeStorage() throws Exception {
    try(var account=account(); var guest=new AuthHttpClient(port)) {
      UUID subject=subject(account);
      assertThat(guest.error(upload(guest,subject,UUID.randomUUID(),null,MaterialInputTest.PDF,"a.pdf",false,false),403)).isEqualTo("CSRF_INVALID");
      guest.csrf();
      assertThat(guest.error(upload(guest,subject,UUID.randomUUID(),null,MaterialInputTest.PDF,"a.pdf",true,false),401)).isEqualTo("AUTHENTICATION_REQUIRED");
      assertThat(account.error(upload(account,subject,UUID.randomUUID(),null,MaterialInputTest.PDF,"a.pdf",false,false),403)).isEqualTo("CSRF_INVALID");
      assertThat(account.error(upload(account,subject,null,null,MaterialInputTest.PDF,"a.pdf",true,false),400)).isEqualTo("IDEMPOTENCY_KEY_REQUIRED");
      assertThat(account.error(upload(account,subject,UUID.randomUUID(),null,new byte[]{1,2,3},"a.pdf",true,false),422)).isEqualTo("INVALID_PDF");
      assertThat(account.error(upload(account,subject,UUID.randomUUID(),"x".repeat(161),MaterialInputTest.PDF,"a.pdf",true,false),422)).isEqualTo("VALIDATION_FAILED");
      byte[] overflow=new byte[(int)MaterialLimits.MAX_UPLOAD_BYTES+1];
      assertThat(account.error(upload(account,subject,UUID.randomUUID(),null,overflow,"a.pdf",true,true),413)).isEqualTo("PAYLOAD_TOO_LARGE");
      for(String query:List.of("ownerId=1","page=0","q=a&q=b","pageSize=101","subjectId=1-1-1-1-1"))
        assertThat(account.send("GET","/materials?"+query,null,null).statusCode()).isEqualTo(400);
      when(storage.enabled()).thenReturn(false);
      assertThat(account.error(upload(account,subject,UUID.randomUUID(),null,MaterialInputTest.PDF,"a.pdf",true,false),503)).isEqualTo("STORAGE_UNAVAILABLE");
      assertThat(puts.get()).isZero(); assertThat(usage(account).get("reservedBytes").asLong()).isZero();
    }
  }

  @Test void concurrentReservationsCannotExceedQuotaAndSameKeyCannotUploadTwice() throws Exception {
    var fixture=fixture(); long max=MaterialLimits.MAX_UPLOAD_BYTES;
    for(int i=0;i<19;i++) repository.reserve(fixture.owner,UUID.randomUUID(),input(fixture.subject,max),"0".repeat(64));
    try(var executor=Executors.newFixedThreadPool(2)) {
      var start=new CountDownLatch(1);
      Callable<String> reserve=() -> { start.await(); try { repository.reserve(fixture.owner,UUID.randomUUID(),input(fixture.subject,max),"0".repeat(64)); return "ok"; }
        catch(ApiException error) { return error.response().error().code(); } };
      var a=executor.submit(reserve); var b=executor.submit(reserve); start.countDown();
      assertThat(List.of(a.get(10,TimeUnit.SECONDS),b.get(10,TimeUnit.SECONDS))).containsExactlyInAnyOrder("ok","STORAGE_QUOTA_EXCEEDED");
      assertThat(repository.usage(fixture.owner).reservedBytes()).isEqualTo(MaterialLimits.ACCOUNT_BYTES);
    }
    var second=fixture(); UUID key=UUID.randomUUID();
    var first=repository.reserve(second.owner,key,input(second.subject,max),"0".repeat(64));
    assertThatThrownBy(() -> repository.reserve(second.owner,key,input(second.subject,max),"0".repeat(64)))
        .isInstanceOf(ApiException.class).extracting(e -> ((ApiException)e).response().error().code()).isEqualTo("REQUEST_IN_PROGRESS");
    assertThat(repository.usage(second.owner).reservedBytes()).isEqualTo(max);
    assertThat(first.id()).isNotNull();
  }

  @Test void realHttpAcceptsExact25MiBAndRejectsInvalidRenameWithoutChangingMaterial() throws Exception {
    try(var account=account()) {
      UUID subject=subject(account);
      byte[] pdf=new byte[(int)MaterialLimits.MAX_UPLOAD_BYTES]; Arrays.fill(pdf,(byte)' ');
      System.arraycopy("%PDF-2.0".getBytes(StandardCharsets.US_ASCII),0,pdf,0,8);
      System.arraycopy("%%EOF".getBytes(StandardCharsets.US_ASCII),0,pdf,pdf.length-5,5);
      var item=account.data(upload(account,subject,UUID.randomUUID(),null,pdf,"文".repeat(176)+".PDF",true,false),201);
      assertThat(item.get("fileName").asString()).hasSize(180);
      assertThat(item.get("title").asString()).hasSize(160);
      UUID id=UUID.fromString(item.get("id").asString());
      assertThat(item.get("sizeBytes").asLong()).isEqualTo(26_214_400);
      assertThat(usage(account).get("usedBytes").asLong()).isEqualTo(26_214_400);
      for(String body:List.of("null","{}","{\"title\":\"A\",\"version\":\"1\"}",
          "{\"title\":null,\"version\":1}","{\"title\":\"\",\"version\":1}",
          "{\"title\":\"A\",\"version\":1,\"ownerId\":\"fake\"}","{\"title\":\"A\",\"version\":0}"))
        assertThat(account.error(account.send("PATCH","/materials/"+id,body,account.token),422)).isEqualTo("VALIDATION_FAILED");
      assertThat(account.error(account.send("PATCH","/materials/"+id,Map.of("title","A","version",1),null),403)).isEqualTo("CSRF_INVALID");
      assertThat(account.error(account.send("DELETE","/materials/"+id,null,null),403)).isEqualTo("CSRF_INVALID");
      assertThat(account.data(account.send("GET","/materials/"+id,null,null),200).get("version").asLong()).isEqualTo(1);
      UUID job=UUID.fromString(account.data(account.send("DELETE","/materials/"+id,null,account.token),202).get("jobId").asString());
      driver.run(job,handler); assertThat(objects).isEmpty();
    }
  }

  @Test void overlappingHttpUploadsShareIdempotencyAndLimitConcurrentTemporaryFiles() throws Exception {
    var entered=new CountDownLatch(2); var release=new CountDownLatch(1);
    doAnswer(call -> { entered.countDown(); if(!release.await(10,TimeUnit.SECONDS)) throw new StorageFailure(); return null; })
        .when(storage).put(anyString(),anyLong(),anyString(),any());
    try(var account=account(); var executor=Executors.newFixedThreadPool(2)) {
      UUID subject=subject(account); UUID firstKey=UUID.randomUUID();
      var first=executor.submit(() -> upload(account,subject,firstKey,null,MaterialInputTest.PDF,"a.pdf",true,false));
      long deadline=System.nanoTime()+Duration.ofSeconds(5).toNanos();
      while(entered.getCount()==2 && System.nanoTime()<deadline) Thread.sleep(10);
      assertThat(entered.getCount()).isEqualTo(1);
      assertThat(account.error(upload(account,subject,firstKey,null,MaterialInputTest.PDF,"a.pdf",true,false),409)).isEqualTo("REQUEST_IN_PROGRESS");
      var second=executor.submit(() -> upload(account,subject,UUID.randomUUID(),null,MaterialInputTest.PDF,"b.pdf",true,false));
      assertThat(entered.await(5,TimeUnit.SECONDS)).isTrue();
      var busy=upload(account,subject,UUID.randomUUID(),null,MaterialInputTest.PDF,"c.pdf",true,false);
      assertThat(account.error(busy,429)).isEqualTo("UPLOAD_BUSY");
      assertThat(busy.headers().firstValue("Retry-After")).hasValue("2");
      assertThat(usage(account).get("reservedBytes").asLong()).isEqualTo(2L*MaterialInputTest.PDF.length);
      release.countDown();
      account.data(first.get(5,TimeUnit.SECONDS),201); account.data(second.get(5,TimeUnit.SECONDS),201);
      assertThat(usage(account).get("usedBytes").asLong()).isEqualTo(2L*MaterialInputTest.PDF.length);
      assertThat(usage(account).get("reservedBytes").asLong()).isZero();
    } finally { release.countDown(); }
  }

  @Test void rollbackAfterReservationDoesNotConsumeQuotaOrLeaveMetadata() {
    var fixture=fixture();
    assertThatThrownBy(() -> new TransactionTemplate(transactionManager).execute(s -> {
      repository.reserve(fixture.owner,UUID.randomUUID(),input(fixture.subject,100),"0".repeat(64));
      throw new IllegalStateException("test rollback");
    })).isInstanceOf(IllegalStateException.class);
    assertThat(repository.usage(fixture.owner).reservedBytes()).isZero();
    assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.materials WHERE owner_id=?",Integer.class,fixture.owner)).isZero();
  }

  @Test void uncertainPutKeepsQuotaAndKeyUntilCleanupAndSurvivesLostCompletion() throws Exception {
    var fixture=fixture(); UUID key=UUID.randomUUID();
    doAnswer(call -> { objects.put(call.getArgument(0),MaterialInputTest.PDF); throw new StorageFailure(); })
        .when(storage).put(anyString(),anyLong(),anyString(),any());
    assertThatThrownBy(() -> service.upload(fixture.owner,key,input(fixture.subject,100)))
        .isInstanceOf(ApiException.class).extracting(e -> ((ApiException)e).response().error().code()).isEqualTo("UPLOAD_FAILED");
    UUID id=jdbc.queryForObject("SELECT id FROM studymate.material_objects WHERE owner_id=?",UUID.class,fixture.owner);
    var item=repository.object(fixture.owner,id,false);
    assertThat(item.state()).isEqualTo("deleting"); assertThat(item.ready()).isFalse();
    assertThat(repository.usage(fixture.owner).reservedBytes()).isEqualTo(100); assertThat(objects).hasSize(1);
    assertThat(jdbc.queryForObject("SELECT next_attempt_at > clock_timestamp()+interval '4 minutes' FROM studymate.jobs WHERE id=?",Boolean.class,item.jobId())).isTrue();
    makeReady(id);
    var lease=driver.claim(item.jobId());
    var outcome=handler.execute(lease); assertThat(outcome).isInstanceOf(JobOutcome.Succeeded.class); assertThat(objects).isEmpty();
    // Crash after remote DELETE but before the DB callback: reservation and metadata must still exist.
    assertThat(repository.usage(fixture.owner).reservedBytes()).isEqualTo(100);
    jdbc.update("UPDATE studymate.jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=?",item.jobId());
    assertThat(driver.finish(lease,outcome)).isFalse(); driver.recover(); driver.run(item.jobId(),handler);
    assertThat(repository.usage(fixture.owner).reservedBytes()).isZero();
    assertThat(repository.object(fixture.owner,id,false).state()).isEqualTo("deleted");
    assertThatThrownBy(() -> repository.stored(fixture.owner,id)).isInstanceOf(ApiException.class);
    // A very late original PUT cannot resurrect the DB material. The retained key allows a later audit to delete it.
    objects.put(item.objectKey(),MaterialInputTest.PDF);
    jdbc.update("UPDATE studymate.material_objects SET audit_after=clock_timestamp()-INTERVAL '1 day' WHERE id=?",id);
    new MaterialMaintenance(repository,storage).recover(); assertThat(objects).isEmpty();
  }

  @Test void failedCleanupDoesNotFreeBytesAndExplicitRetryIsOneSharedNewJob() throws Exception {
    var f=fixture(); var r=repository.reserve(f.owner,UUID.randomUUID(),input(f.subject,100),"0".repeat(64)); repository.stored(f.owner,r.id());
    var deletion=repository.delete(f.owner,r.id());
    jdbc.update("UPDATE studymate.jobs SET max_attempts=1 WHERE id=?",deletion.jobId());
    doThrow(new StorageFailure()).when(storage).delete(anyString()); driver.run(deletion.jobId(),handler);
    assertThat(repository.usage(f.owner).usedBytes()).isEqualTo(100);
    assertThat(jdbc.queryForObject("SELECT status FROM studymate.jobs WHERE id=?",String.class,deletion.jobId())).isEqualTo("failed");
    var retry=repository.delete(f.owner,r.id()); assertThat(retry.jobId()).isNotEqualTo(deletion.jobId());
    assertThat(repository.delete(f.owner,r.id())).isEqualTo(retry);
    doNothing().when(storage).delete(anyString()); driver.run(retry.jobId(),handler);
    assertThat(repository.usage(f.owner).usedBytes()).isZero();
  }

  @Test void deletionRacingDelayedUploadCannotPublishOrReleaseTwice() throws Exception {
    var f=fixture(); var entered=new CountDownLatch(1); var release=new CountDownLatch(1);
    doAnswer(call -> { entered.countDown(); if(!release.await(5,TimeUnit.SECONDS)) throw new StorageFailure(); return null; })
        .when(storage).put(anyString(),anyLong(),anyString(),any());
    try(var executor=Executors.newSingleThreadExecutor()) {
      var uploading=executor.submit(() -> service.upload(f.owner,UUID.randomUUID(),input(f.subject,100)));
      assertThat(entered.await(5,TimeUnit.SECONDS)).isTrue();
      UUID id=jdbc.queryForObject("SELECT id FROM studymate.material_objects WHERE owner_id=?",UUID.class,f.owner);
      var deletion=repository.delete(f.owner,id); release.countDown();
      assertThatThrownBy(() -> uploading.get(5,TimeUnit.SECONDS)).hasCauseInstanceOf(ApiException.class);
      assertThat(repository.object(f.owner,id,false).state()).isEqualTo("deleting");
      makeReady(id); driver.run(deletion.jobId(),handler);
      assertThat(repository.usage(f.owner).reservedBytes()).isZero();
      assertThatThrownBy(() -> repository.delete(f.owner,id)).isInstanceOf(ApiException.class);
    } finally { release.countDown(); }
  }

  @Test void expiredReservationIsRecoveredWithoutLocalFileAndForeignCompositeFkIsRejected() {
    var f=fixture(); var other=fixture();
    var r=repository.reserve(f.owner,UUID.randomUUID(),input(f.subject,100),"0".repeat(64));
    jdbc.update("UPDATE studymate.material_objects SET upload_expires_at=clock_timestamp()-INTERVAL '1 second',cleanup_not_before=clock_timestamp() WHERE id=?",r.id());
    new MaterialMaintenance(repository,storage).recover();
    var deletion=repository.object(f.owner,r.id(),false);
    assertThat(deletion.state()).isEqualTo("deleting"); assertThat(deletion.jobId()).isNotNull();
    assertThatThrownBy(() -> jdbc.update("UPDATE studymate.materials SET subject_id=? WHERE id=?",other.subject,r.id()))
        .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
    assertThatThrownBy(() -> jdbc.update("DELETE FROM studymate.subjects WHERE id=?",f.subject))
        .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
  }

  @Test void domainDeleteRollbackRetainsQuotaAndObjectKey() throws Exception {
    var f=fixture(); var r=repository.reserve(f.owner,UUID.randomUUID(),input(f.subject,100),"0".repeat(64)); repository.stored(f.owner,r.id());
    var deletion=repository.delete(f.owner,r.id());
    jdbc.execute("CREATE TABLE studymate.stage8_block_cleanup_test(material_id UUID REFERENCES studymate.materials(id) ON DELETE RESTRICT)");
    try {
      jdbc.update("INSERT INTO studymate.stage8_block_cleanup_test VALUES (?)",r.id());
      var lease=driver.claim(deletion.jobId()); var outcome=handler.execute(lease);
      assertThatThrownBy(() -> driver.finish(lease,outcome)).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
      assertThat(repository.object(f.owner,r.id(),false).state()).isEqualTo("deleting");
      assertThat(repository.usage(f.owner).usedBytes()).isEqualTo(100);
      assertThat(jdbc.queryForObject("SELECT status FROM studymate.jobs WHERE id=?",String.class,deletion.jobId())).isEqualTo("running");
    } finally { jdbc.execute("DROP TABLE studymate.stage8_block_cleanup_test"); }
  }

  private AuthHttpClient account() throws Exception {
    var client=new AuthHttpClient(port); String email="material-"+UUID.randomUUID()+"@example.com";
    client.register(email); client.data(client.login(email),200); client.csrf(); return client;
  }
  private UUID subject(AuthHttpClient client) throws Exception {
    return UUID.fromString(client.data(client.send("POST","/subjects",Map.of("title","Предмет","icon","book","tone","blue"),client.token,
        Map.of("Idempotency-Key",UUID.randomUUID().toString())),201).get("id").asString());
  }
  private int subjectCount(AuthHttpClient client,UUID subject) throws Exception {
    return client.data(client.send("GET","/subjects/"+subject,null,null),200).get("lectureCount").asInt();
  }
  private JsonNode usage(AuthHttpClient client) throws Exception { return client.data(client.send("GET","/storage/usage",null,null),200); }
  private record Fixture(UUID owner,UUID subject) {}
  private Fixture fixture() {
    UUID owner=UUID.randomUUID(),subject=UUID.randomUUID();
    jdbc.update("INSERT INTO studymate.users(id,normalized_email,display_name,password_hash) VALUES (?,?,'Materials test','{test-only}unusable')",owner,owner+"@example.com");
    jdbc.update("INSERT INTO studymate.subjects(id,owner_id,title,normalized_title,description,normalized_description,icon,tone) VALUES (?,?,'Test','test','','','book','blue')",subject,owner);
    return new Fixture(owner,subject);
  }
  private MaterialInput input(UUID subject,long bytes) {
    return new MaterialInput(subject,"Title","fixture.pdf",bytes,"0".repeat(64),new org.springframework.mock.web.MockPart("file","fixture.pdf",MaterialInputTest.PDF));
  }
  private void makeReady(UUID id) { jdbc.update("UPDATE studymate.material_objects SET cleanup_not_before=clock_timestamp()-INTERVAL '1 second' WHERE id=?",id); }

  private HttpResponse<String> upload(AuthHttpClient client,UUID subject,UUID key,String title,byte[] pdf,String name,boolean csrf,boolean chunked) throws Exception {
    String boundary="test-"+UUID.randomUUID(); var bytes=new ByteArrayOutputStream();
    bytes.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"subjectId\"\r\n\r\n"+subject+"\r\n").getBytes(StandardCharsets.UTF_8));
    if(title!=null) bytes.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\n"+title+"\r\n").getBytes(StandardCharsets.UTF_8));
    bytes.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\""+name+"\"\r\nContent-Type: application/pdf\r\n\r\n").getBytes(StandardCharsets.UTF_8));
    bytes.write(pdf); bytes.write(("\r\n--"+boundary+"--\r\n").getBytes(StandardCharsets.UTF_8));
    byte[] body=bytes.toByteArray();
    var builder=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/materials")).timeout(Duration.ofSeconds(30))
        .header("Content-Type","multipart/form-data; boundary="+boundary);
    if(client.cookie!=null) builder.header("Cookie",client.cookie);
    if(csrf && client.token!=null) builder.header("X-CSRF-TOKEN",client.token);
    if(key!=null) builder.header("Idempotency-Key",key.toString());
    builder.POST(chunked ? HttpRequest.BodyPublishers.ofInputStream(() -> new java.io.ByteArrayInputStream(body)) : HttpRequest.BodyPublishers.ofByteArray(body));
    try(var http=HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()) {
      var response=http.send(builder.build(),HttpResponse.BodyHandlers.ofString());
      assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store"); return response;
    }
  }
}
