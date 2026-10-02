package com.studymate.materials;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.studymate.PostgresIntegrationTest;
import com.studymate.ai.*;
import com.studymate.identity.AuthHttpClient;
import com.studymate.jobs.*;
import com.studymate.materials.pdf.PdfFixtures;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.regex.Pattern;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockPart;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties={"studymate.registration.enabled=true","server.servlet.session.cookie.secure=false",
        "spring.profiles.active=local","studymate.ai.provider=fake"})
@Import({MaterialJobTestDriver.class, MaterialTextHandler.class, MaterialCleanupHandler.class})
class QuizIT extends PostgresIntegrationTest {
  @Value("${local.server.port}") int port;
  @Autowired MaterialService materials;
  @Autowired MaterialRepository repository;
  @Autowired MaterialTextHandler extraction;
  @Autowired MaterialCleanupHandler cleanup;
  @Autowired MaterialJobTestDriver driver;
  @Autowired JdbcTemplate jdbc;
  @Autowired List<JobHandler> handlers;
  @Autowired PlatformTransactionManager transactions;
  @MockitoBean ObjectStorage storage;
  @MockitoBean QuizProvider provider;
  @MockitoBean SummaryProvider notes;
  private final JsonMapper json = JsonMapper.builder().build();
  private byte[] pdf;

  @BeforeEach void configure() throws Exception {
    pdf = PdfFixtures.text("Учебные данные для проверки тестов");
    when(storage.enabled()).thenReturn(true);
    when(provider.available()).thenReturn(true);
    when(provider.model()).thenReturn("fixture-quiz");
    when(notes.available()).thenReturn(true);
    when(provider.generate(anyString(), anySet())).thenReturn(QuizFixtures.result());
    doAnswer(call -> { Files.write((Path)call.getArgument(1), pdf); return null; })
        .when(storage).fetch(anyString(), any(), anyLong(), anyString());
  }

  @Test void versionsAreImmutablePublicProjectionHidesAllKeysAndReadsDoNotGenerate() throws Exception {
    try (var owner = account(); var other = account(); var anonymous = new AuthHttpClient(port)) {
      UUID material = material(owner, true);
      var initial = list(owner, material, "");
      assertThat(initial.path("data").size()).isZero();
      assertThat(initial.at("/meta/generation/status").asString()).isEqualTo("not_started");
      assertThat(other.http.error(other.http.send("GET", route(material), null, null), 404)).isEqualTo("MATERIAL_NOT_FOUND");
      assertThat(anonymous.error(anonymous.send("GET", route(material), null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      UUID key = UUID.randomUUID(), job = start(owner, material, key);
      assertThat(start(owner, material, key)).isEqualTo(job);
      assertThat(owner.http.error(post(owner, material, UUID.randomUUID(), owner.http.token), 409)).isEqualTo("QUIZ_IN_PROGRESS");
      assertThat(list(owner, material, "").at("/meta/generation/status").asString()).isEqualTo("queued");
      UUID firstId = run(owner, job);
      var first = get(owner, firstId);
      assertThat(first.path("id").asString()).isEqualTo(firstId.toString());
      assertThat(first.path("version").asInt()).isEqualTo(1);
      assertThat(first.path("questionCount").asInt()).isEqualTo(10);
      assertThat(first.path("questions").size()).isEqualTo(10);
      assertThat(first.size()).isEqualTo(7);
      for (var question : first.path("questions")) {
        assertThat(question.size()).isEqualTo(4);
        assertThat(question.path("options").size()).isEqualTo(4);
        for (var option : question.path("options")) assertThat(option.size()).isEqualTo(3);
      }
      assertNoKeys(first);
      assertThat(get(owner, firstId)).isEqualTo(first);
      assertThat(other.http.error(other.http.send("GET", "/quizzes/" + firstId, null, null), 404)).isEqualTo("QUIZ_NOT_FOUND");
      assertThat(anonymous.error(anonymous.send("GET", "/quizzes/" + firstId, null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      UUID secondJob = start(owner, material, UUID.randomUUID());
      assertThat(list(owner, material, "").path("data").get(0).path("id").asString()).isEqualTo(firstId.toString());
      UUID secondId = run(owner, secondJob);
      assertThat(secondId).isNotEqualTo(firstId);
      assertThat(get(owner, secondId).path("version").asInt()).isEqualTo(2);
      assertThat(get(owner, firstId)).isEqualTo(first);
      var page = list(owner, material, "?pageSize=1&page=2");
      assertThat(page.at("/meta/total").asInt()).isEqualTo(2);
      assertThat(page.path("data").get(0).path("id").asString()).isEqualTo(firstId.toString());
      assertThat(list(owner, material, "?page=9007199254740991").path("data").size()).isZero();
      assertNoKeys(page);
      assertThat(start(owner, material, key)).isEqualTo(job);
      verify(provider, times(2)).generate(anyString(), anySet());
      verify(notes, never()).summarize(anyString(), anySet());
    }
  }

  @Test void validatesAuthorizationCsrfInputAndProviderBeforeEnqueue() throws Exception {
    try (var owner = account(); var other = account()) {
      UUID material = material(owner, false);
      assertThat(owner.http.error(post(owner, material, UUID.randomUUID(), null), 403)).isEqualTo("CSRF_INVALID");
      assertThat(owner.http.error(post(owner, material, null, owner.http.token), 400)).isEqualTo("IDEMPOTENCY_KEY_REQUIRED");
      assertThat(other.http.error(post(other, material, UUID.randomUUID(), other.http.token), 404)).isEqualTo("MATERIAL_NOT_FOUND");
      assertThat(owner.http.error(post(owner, material, UUID.randomUUID(), owner.http.token), 409)).isEqualTo("TEXT_NOT_READY");
      assertThat(owner.http.error(owner.http.send("POST", route(material), "{}", owner.http.token,
          Map.of("Idempotency-Key", UUID.randomUUID().toString())), 400)).isEqualTo("INVALID_REQUEST");
      assertThat(owner.http.error(owner.http.send("POST", route(material), null, owner.http.token,
          Map.of("Idempotency-Key", "wrong")), 400)).isEqualTo("INVALID_IDEMPOTENCY_KEY");
      for (String query : List.of("?page=0", "?pageSize=101", "?page=1&page=2", "?unknown=1", "?pageSize=x"))
        assertThat(owner.http.error(owner.http.send("GET", route(material) + query, null, null), 400)).isEqualTo("INVALID_QUERY");
      assertThat(owner.http.error(owner.http.send("GET", "/quizzes/bad", null, null), 400)).isEqualTo("INVALID_ID");
      when(provider.available()).thenReturn(false);
      assertThat(owner.http.error(post(owner, material, UUID.randomUUID(), owner.http.token), 503)).isEqualTo("AI_UNAVAILABLE");
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.jobs WHERE owner_id=? AND kind='material.quiz'", Integer.class, owner.id)).isZero();
      list(owner, material, "");
      verify(provider, never()).generate(anyString(), anySet());
    }
  }

  @Test void keyCannotBeReusedForAnotherMaterial() throws Exception {
    try (var owner = account()) {
      UUID one = material(owner, true), two = material(owner, true), key = UUID.randomUUID();
      UUID job = start(owner, one, key);
      assertThat(owner.http.error(post(owner, two, key, owner.http.token), 409)).isEqualTo("IDEMPOTENCY_KEY_REUSED");
      run(owner, job);
    }
  }

  @Test void failurePreservesPreviousVersionAndExplicitNewKeyIsRequired() throws Exception {
    try (var owner = account()) {
      UUID material = material(owner, true);
      UUID original = run(owner, start(owner, material, UUID.randomUUID()));
      var first = get(owner, original);
      doThrow(new AiFailure(JobError.QUIZ_INSUFFICIENT_CONTENT)).when(provider).generate(anyString(), anySet());
      UUID key = UUID.randomUUID(), failed = start(owner, material, key);
      driver.run(failed, handler());
      var state = list(owner, material, "");
      assertThat(state.at("/meta/generation/status").asString()).isEqualTo("failed");
      assertThat(state.at("/meta/generation/error/code").asString()).isEqualTo("QUIZ_INSUFFICIENT_CONTENT");
      assertThat(state.path("data").size()).isEqualTo(1);
      assertThat(get(owner, original)).isEqualTo(first);
      assertThat(start(owner, material, key)).isEqualTo(failed);
      doReturn(QuizFixtures.result()).when(provider).generate(anyString(), anySet());
      UUID latest = run(owner, start(owner, material, UUID.randomUUID()));
      assertThat(get(owner, latest).path("version").asInt()).isEqualTo(2);
      verify(provider, times(3)).generate(anyString(), anySet());
    }
  }

  @Test void invalidResponseIsNotPartiallySaved() throws Exception {
    try (var owner = account()) {
      UUID material = material(owner, true);
      when(provider.generate(anyString(), anySet())).thenReturn(new QuizProvider.Result(QuizFixtures.result().questions().subList(0, 9), 5, 5));
      UUID job = start(owner, material, UUID.randomUUID()); driver.run(job, handler());
      assertThat(list(owner, material, "").at("/meta/generation/error/code").asString()).isEqualTo("AI_INVALID_RESPONSE");
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.quizzes WHERE material_id=?", Integer.class, material)).isZero();
    }
  }

  @Test void deletionCancelsRunningGenerationFencesLateResultAndCascadesEveryVersion() throws Exception {
    try (var owner = account()) {
      UUID material = material(owner, true);
      UUID saved = run(owner, start(owner, material, UUID.randomUUID()));
      UUID job = start(owner, material, UUID.randomUUID());
      var lease = driver.claim(job, "material.quiz");
      var outcome = handler().execute(lease);
      var deletion = repository.delete(owner.id, material);
      assertThat(driver.finish(lease, outcome)).isFalse();
      assertThat(owner.http.error(owner.http.send("GET", "/quizzes/" + saved, null, null), 409)).isEqualTo("MATERIAL_NOT_AVAILABLE");
      assertThat(owner.http.error(post(owner, material, UUID.randomUUID(), owner.http.token), 409)).isEqualTo("MATERIAL_NOT_AVAILABLE");
      driver.run(deletion.jobId(), cleanup);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.quizzes WHERE material_id=?", Integer.class, material)).isZero();
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.quiz_questions WHERE quiz_id=?", Integer.class, saved)).isZero();
      assertThat(owner.http.error(owner.http.send("GET", "/quizzes/" + saved, null, null), 404)).isEqualTo("QUIZ_NOT_FOUND");
      assertThat(repository.usage(owner.id).usedBytes()).isZero();
    }
  }

  @Test void concurrentSameKeyCreatesOneJobAndDifferentKeysDoNotQueueParallelVersions() throws Exception {
    try (var owner = account(); var pool = Executors.newFixedThreadPool(2)) {
      UUID material = material(owner, true), key = UUID.randomUUID();
      var gate = new CountDownLatch(1);
      var one = pool.submit(() -> { gate.await(); return start(owner, material, key); });
      var two = pool.submit(() -> { gate.await(); return start(owner, material, key); });
      gate.countDown();
      UUID job = one.get(10, TimeUnit.SECONDS);
      assertThat(two.get(10, TimeUnit.SECONDS)).isEqualTo(job);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.jobs WHERE owner_id=? AND kind='material.quiz'", Integer.class, owner.id)).isEqualTo(1);
      run(owner, job);
      var nextGate = new CountDownLatch(1);
      var a = pool.submit(() -> { nextGate.await(); return post(owner, material, UUID.randomUUID(), owner.http.token); });
      var b = pool.submit(() -> { nextGate.await(); return post(owner, material, UUID.randomUUID(), owner.http.token); });
      nextGate.countDown();
      var ra = a.get(10, TimeUnit.SECONDS); var rb = b.get(10, TimeUnit.SECONDS);
      assertThat(List.of(ra.statusCode(), rb.statusCode())).containsExactlyInAnyOrder(202, 409);
      var accepted = ra.statusCode() == 202 ? ra : rb;
      run(owner, UUID.fromString(owner.http.data(accepted, 202).path("jobId").asString()));
    }
  }

  @Test void expiredManualLeaseCannotPublishOrTriggerAutomaticSecondCall() throws Exception {
    try (var owner = account()) {
      UUID material = material(owner, true), key = UUID.randomUUID();
      UUID job = start(owner, material, key);
      var lease = driver.claim(job, "material.quiz"); var outcome = handler().execute(lease);
      jdbc.update("UPDATE studymate.jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=?", job);
      driver.recover();
      assertThat(driver.finish(lease, outcome)).isFalse();
      assertThat(start(owner, material, key)).isEqualTo(job);
      var status = owner.http.data(owner.http.send("GET", "/jobs/" + job, null, null), 200);
      assertThat(status.path("status").asString()).isEqualTo("failed");
      assertThat(status.at("/error/code").asString()).isEqualTo("JOB_OUTCOME_UNKNOWN");
      assertThat(list(owner, material, "").path("data").size()).isZero();
      verify(provider, times(1)).generate(anyString(), anySet());
    }
  }

  @Test void databaseRejectsAnAnswerFromAnotherQuestion() throws Exception {
    try (var owner = account()) {
      UUID quiz = run(owner, start(owner, material(owner, true), UUID.randomUUID()));
      var rows = jdbc.queryForList("SELECT id,correct_option_id FROM studymate.quiz_questions WHERE quiz_id=? ORDER BY position", quiz);
      assertThatThrownBy(() -> new TransactionTemplate(transactions).execute(status -> {
        jdbc.update("UPDATE studymate.quiz_questions SET correct_option_id=? WHERE id=?", rows.get(1).get("correct_option_id"), rows.get(0).get("id"));
        return null;
      })).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
    }
  }

  @Test void queuedGenerationRunsInPackagedApplicationAndVersionSurvivesRestart() throws Exception {
    try (var owner = account()) {
      UUID material = material(owner, true), job = start(owner, material, UUID.randomUUID());
      UUID quiz;
      JsonNode saved;
      try (var first = startApplication()) {
        long until = System.nanoTime() + Duration.ofSeconds(30).toNanos();
        while (!"succeeded".equals(jdbc.queryForObject("SELECT status FROM studymate.jobs WHERE id=?", String.class, job))
            && first.process.isAlive() && System.nanoTime() < until) Thread.sleep(50);
        assertThat(jdbc.queryForObject("SELECT status FROM studymate.jobs WHERE id=?", String.class, job)).as("see %s", first.log).isEqualTo("succeeded");
        quiz = jdbc.queryForObject("SELECT result_id FROM studymate.jobs WHERE id=?", UUID.class, job);
        try (var http = new AuthHttpClient(first.port)) {
          http.cookie = owner.http.cookie;
          saved = http.data(http.send("GET", "/quizzes/" + quiz, null, null), 200);
          assertThat(saved.path("model").asString()).isEqualTo("fake-local");
          assertNoKeys(saved);
        }
      }
      try (var second = startApplication(); var http = new AuthHttpClient(second.port)) {
        http.cookie = owner.http.cookie;
        assertThat(http.data(http.send("GET", "/quizzes/" + quiz, null, null), 200)).isEqualTo(saved);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.quizzes WHERE material_id=?", Integer.class, material)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT attempt_count FROM studymate.jobs WHERE id=?", Integer.class, job)).isEqualTo(1);
      }
      verify(provider, never()).generate(anyString(), anySet());
    }
  }

  private Running startApplication() throws Exception {
    Path log = Files.createTempFile(Path.of("target"), "quiz-restart-", ".log");
    var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
        "-jar", "target/studymate-backend-0.1.0-SNAPSHOT.jar", "--spring.profiles.active=local",
        "--server.address=127.0.0.1", "--server.port=0", "--studymate.ai.provider=fake",
        "--studymate.r2.enabled=false", "--studymate.jobs.enabled=true", "--studymate.jobs.poll-interval-ms=100",
        "--studymate.materials.maintenance-enabled=false")
        .redirectErrorStream(true).redirectOutput(log.toFile());
    builder.environment().remove("STUDYMATE_OPENAI_API_KEY");
    builder.environment().remove("STUDYMATE_R2_ACCESS_KEY_ID");
    builder.environment().remove("STUDYMATE_R2_SECRET_ACCESS_KEY");
    for (String suffix : List.of("URL", "USERNAME", "PASSWORD"))
      builder.environment().put("STUDYMATE_DATABASE_" + suffix, System.getenv("STUDYMATE_TEST_DATABASE_" + suffix));
    Process process = builder.start();
    long until = System.nanoTime() + Duration.ofSeconds(40).toNanos();
    while (process.isAlive() && System.nanoTime() < until) {
      var match = Pattern.compile("Tomcat started on port (\\d+)").matcher(Files.readString(log));
      if (match.find()) return new Running(process, log, Integer.parseInt(match.group(1)));
      Thread.sleep(50);
    }
    process.destroyForcibly(); process.waitFor(10, TimeUnit.SECONDS);
    throw new AssertionError("Quiz test application did not start; see " + log);
  }
  private record Running(Process process, Path log, int port) implements AutoCloseable {
    public void close() throws Exception {
      if (!process.isAlive()) return;
      process.destroy();
      if (!process.waitFor(5, TimeUnit.SECONDS)) { process.destroyForcibly(); assertThat(process.waitFor(5, TimeUnit.SECONDS)).isTrue(); }
    }
  }

  private void assertNoKeys(JsonNode value) {
    assertThat(value.toString()).doesNotContain("correctIndex", "correctOptionId", "explanation", "sourcePages", "Секретное объяснение", "payload");
  }
  private JsonNode list(Account account, UUID material, String query) throws Exception {
    var response = account.http.send("GET", route(material) + query, null, null);
    assertThat(response.statusCode()).isEqualTo(200); return json.readTree(response.body());
  }
  private JsonNode get(Account account, UUID quiz) throws Exception { return account.http.data(account.http.send("GET", "/quizzes/" + quiz, null, null), 200); }
  private UUID run(Account owner, UUID job) throws Exception {
    driver.run(job, handler());
    var status = owner.http.data(owner.http.send("GET", "/jobs/" + job, null, null), 200);
    assertThat(status.path("status").asString()).isEqualTo("succeeded"); assertNoKeys(status);
    return UUID.fromString(status.path("resultId").asString());
  }
  private JobHandler handler() { return handlers.stream().filter(h -> h.kind().equals("material.quiz")).findFirst().orElseThrow(); }
  private record Account(UUID id, AuthHttpClient http) implements AutoCloseable { public void close() { http.close(); } }
  private Account account() throws Exception {
    var client = new AuthHttpClient(port); String email = "quiz-" + UUID.randomUUID() + "@example.com";
    UUID id = UUID.fromString(client.register(email)); client.data(client.login(email), 200); client.csrf(); return new Account(id, client);
  }
  private UUID material(Account owner, boolean ready) throws Exception {
    UUID subject = UUID.fromString(owner.http.data(owner.http.send("POST", "/subjects",
        Map.of("title", "Quiz " + UUID.randomUUID(), "icon", "book", "tone", "blue"), owner.http.token,
        Map.of("Idempotency-Key", UUID.randomUUID().toString())), 201).path("id").asString());
    var input = new MaterialInput(subject, "Lecture", "fixture.pdf", pdf.length,
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pdf)), new MockPart("file", "fixture.pdf", pdf));
    UUID material = materials.upload(owner.id, UUID.randomUUID(), input).id();
    if (ready) driver.run(repository.get(owner.id, material).processingJobId(), extraction);
    return material;
  }
  private UUID start(Account owner, UUID material, UUID key) throws Exception {
    return UUID.fromString(owner.http.data(post(owner, material, key, owner.http.token), 202).path("jobId").asString());
  }
  private java.net.http.HttpResponse<String> post(Account owner, UUID material, UUID key, String csrf) throws Exception {
    return owner.http.send("POST", route(material), null, csrf, key == null ? Map.of() : Map.of("Idempotency-Key", key.toString()));
  }
  private static String route(UUID material) { return "/materials/" + material + "/quizzes"; }
}
