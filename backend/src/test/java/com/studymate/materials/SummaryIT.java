package com.studymate.materials;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.studymate.PostgresIntegrationTest;
import com.studymate.ai.SummaryProvider;
import com.studymate.ai.AiFailure;
import com.studymate.identity.AuthHttpClient;
import com.studymate.jobs.*;
import com.studymate.materials.pdf.PdfFixtures;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockPart;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties={"studymate.registration.enabled=true","server.servlet.session.cookie.secure=false",
        "spring.profiles.active=local","studymate.ai.provider=fake"})
@Import({MaterialJobTestDriver.class, MaterialTextHandler.class, MaterialCleanupHandler.class})
class SummaryIT extends PostgresIntegrationTest {
  @Value("${local.server.port}") int port;
  @Autowired MaterialService materials;
  @Autowired MaterialRepository repository;
  @Autowired MaterialTextHandler extraction;
  @Autowired MaterialCleanupHandler cleanup;
  @Autowired MaterialJobTestDriver driver;
  @Autowired JdbcTemplate jdbc;
  @Autowired List<JobHandler> handlers;
  @MockitoBean ObjectStorage storage;
  @MockitoBean SummaryProvider provider;
  private byte[] pdf;

  @BeforeEach void configure() throws Exception {
    pdf=PdfFixtures.text("Тезис лекции про планеты");
    when(storage.enabled()).thenReturn(true);
    when(provider.available()).thenReturn(true);
    when(provider.model()).thenReturn("fixture-model");
    doAnswer(call -> { Files.write((Path)call.getArgument(1),pdf); return null; })
        .when(storage).fetch(anyString(),any(),anyLong(),anyString());
    var count=new AtomicInteger();
    when(provider.summarize(anyString(),anySet())).thenAnswer(call -> {
      Set<Integer> pages=call.getArgument(1);
      return new SummaryProvider.Chunk(List.of(new SummaryProvider.Note(
          "Проверенный тезис номер " + count.incrementAndGet(),List.of(pages.iterator().next()))),10,5);
    });
  }

  @Test void generatesReadsEditsRegeneratesAndDeletesVersions() throws Exception {
    try(var owner=account(); var other=account()) {
      UUID material=readyMaterial(owner);
      assertThat(owner.http.error(owner.http.send("GET","/materials/"+material+"/summary",null,null),404)).isEqualTo("SUMMARY_NOT_FOUND");
      assertThat(other.http.error(other.http.send("GET","/materials/"+material+"/summary",null,null),404)).isEqualTo("MATERIAL_NOT_FOUND");
      assertThat(owner.http.error(post(owner,material,null,null),403)).isEqualTo("CSRF_INVALID");
      assertThat(owner.http.error(post(owner,material,null,owner.http.token),400)).isEqualTo("IDEMPOTENCY_KEY_REQUIRED");
      assertThat(other.http.error(post(other,material,UUID.randomUUID(),other.http.token),404)).isEqualTo("MATERIAL_NOT_FOUND");
      UUID key=UUID.randomUUID();
      var queued=owner.http.data(post(owner,material,key,owner.http.token),202);
      UUID job=UUID.fromString(queued.get("jobId").asString());
      assertThat(owner.http.data(post(owner,material,key,owner.http.token),202)).isEqualTo(queued);
      assertThat(owner.http.error(post(owner,material,UUID.randomUUID(),owner.http.token),409)).isEqualTo("SUMMARY_IN_PROGRESS");
      assertThat(owner.http.data(owner.http.send("GET","/materials/"+material+"/summary",null,null),200)
          .get("status").asString()).isEqualTo("queued");
      driver.run(job,summary());
      var first=owner.http.data(owner.http.send("GET","/materials/"+material+"/summary",null,null),200);
      assertThat(first.get("status").asString()).isEqualTo("ready");
      assertThat(first.get("version").asLong()).isEqualTo(1);
      assertThat(first.get("content").asString()).contains("Проверенный тезис", "стр. 1");
      assertThat(first.get("sourcePages").get(0).asInt()).isEqualTo(1);
      assertThat(first.get("model").asString()).isEqualTo("fixture-model");
      assertThat(owner.http.error(owner.http.send("PATCH","/materials/"+material+"/summary",
          Map.of("version",2,"content","Моя правка"),owner.http.token),409)).isEqualTo("SUMMARY_VERSION_CONFLICT");
      var edited=owner.http.data(owner.http.send("PATCH","/materials/"+material+"/summary",
          Map.of("version",1,"content","Моя правка"),owner.http.token),200);
      assertThat(edited.get("version").asLong()).isEqualTo(2);
      assertThat(edited.get("origin").asString()).isEqualTo("user");
      assertThat(edited.get("sourcePages").size()).isZero();
      UUID again=UUID.fromString(owner.http.data(post(owner,material,UUID.randomUUID(),owner.http.token),202)
          .get("jobId").asString());
      var pending=owner.http.data(owner.http.send("GET","/materials/"+material+"/summary",null,null),200);
      assertThat(pending.get("status").asString()).isEqualTo("queued");
      assertThat(pending.get("content").asString()).isEqualTo("Моя правка");
      driver.run(again,summary());
      var latest=owner.http.data(owner.http.send("GET","/materials/"+material+"/summary",null,null),200);
      assertThat(latest.get("version").asLong()).isEqualTo(3);
      assertThat(latest.get("origin").asString()).isEqualTo("ai");
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.summary_versions WHERE material_id=?",Integer.class,material)).isEqualTo(3);
      var deletion=repository.delete(owner.id,material);
      driver.run(deletion.jobId(),cleanup);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.summary_versions WHERE material_id=?",Integer.class,material)).isZero();
      assertThat(owner.http.error(owner.http.send("GET","/materials/"+material+"/summary",null,null),404)).isEqualTo("MATERIAL_NOT_FOUND");
    }
  }

  @Test void deletionRevokesRunningSummaryAndFencesLateResult() throws Exception {
    try(var owner=account()) {
      UUID material=readyMaterial(owner);
      UUID job=UUID.fromString(owner.http.data(post(owner,material,UUID.randomUUID(),owner.http.token),202).get("jobId").asString());
      var lease=driver.claim(job,"material.summary");
      var outcome=summary().execute(lease);
      var deletion=repository.delete(owner.id,material);
      assertThat(driver.finish(lease,outcome)).isFalse();
      driver.run(deletion.jobId(),cleanup);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.summary_versions WHERE material_id=?",Integer.class,material)).isZero();
    }
  }

  @Test void failedRegenerationRetainsLastVersionUntilExplicitRetry() throws Exception {
    try(var owner=account()) {
      UUID material=readyMaterial(owner);
      UUID first=UUID.fromString(owner.http.data(post(owner,material,UUID.randomUUID(),owner.http.token),202)
          .get("jobId").asString());
      driver.run(first,summary());
      String saved=owner.http.data(owner.http.send("GET","/materials/"+material+"/summary",null,null),200)
          .get("content").asString();
      doThrow(new AiFailure(JobError.AI_UNAVAILABLE)).when(provider).summarize(anyString(),anySet());
      UUID key=UUID.randomUUID();
      UUID failed=UUID.fromString(owner.http.data(post(owner,material,key,owner.http.token),202)
          .get("jobId").asString());
      driver.run(failed,summary());
      var state=owner.http.data(owner.http.send("GET","/materials/"+material+"/summary",null,null),200);
      assertThat(state.get("status").asString()).isEqualTo("failed");
      assertThat(state.get("error").get("code").asString()).isEqualTo("AI_UNAVAILABLE");
      assertThat(state.get("content").asString()).isEqualTo(saved);
      assertThat(state.get("version").asLong()).isEqualTo(1);
      assertThat(owner.http.data(post(owner,material,key,owner.http.token),202).get("jobId").asString())
          .isEqualTo(failed.toString());
      verify(provider,times(2)).summarize(anyString(),anySet());
      doReturn(new SummaryProvider.Chunk(List.of(new SummaryProvider.Note("Новый проверенный тезис",List.of(1))),7,4))
          .when(provider).summarize(anyString(),anySet());
      UUID retry=UUID.fromString(owner.http.data(post(owner,material,UUID.randomUUID(),owner.http.token),202)
          .get("jobId").asString());
      driver.run(retry,summary());
      var latest=owner.http.data(owner.http.send("GET","/materials/"+material+"/summary",null,null),200);
      assertThat(latest.get("version").asLong()).isEqualTo(2);
      assertThat(latest.get("content").asString()).contains("Новый проверенный тезис");
    }
  }

  private JobHandler summary() { return handlers.stream().filter(h -> h.kind().equals("material.summary")).findFirst().orElseThrow(); }
  private record Account(UUID id,AuthHttpClient http) implements AutoCloseable { public void close() { http.close(); } }
  private Account account() throws Exception {
    var client=new AuthHttpClient(port); String email="summary-"+UUID.randomUUID()+"@example.com";
    UUID id=UUID.fromString(client.register(email)); client.data(client.login(email),200); client.csrf(); return new Account(id,client);
  }
  private UUID readyMaterial(Account owner) throws Exception {
    UUID subject=UUID.fromString(owner.http.data(owner.http.send("POST","/subjects",
        Map.of("title","Summary "+UUID.randomUUID(),"icon","book","tone","blue"),owner.http.token,
        Map.of("Idempotency-Key",UUID.randomUUID().toString())),201).get("id").asString());
    var input=new MaterialInput(subject,"Lecture","fixture.pdf",pdf.length,
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pdf)),new MockPart("file","fixture.pdf",pdf));
    UUID material=materials.upload(owner.id,UUID.randomUUID(),input).id();
    driver.run(repository.get(owner.id,material).processingJobId(),extraction);
    return material;
  }
  private java.net.http.HttpResponse<String> post(Account owner,UUID material,UUID key,String csrf) throws Exception {
    return owner.http.send("POST","/materials/"+material+"/summary",null,csrf,
        key==null?Map.of():Map.of("Idempotency-Key",key.toString()));
  }
}
