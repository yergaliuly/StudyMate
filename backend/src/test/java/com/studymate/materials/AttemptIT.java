package com.studymate.materials;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.studymate.PostgresIntegrationTest;
import com.studymate.ai.*;
import com.studymate.identity.AuthHttpClient;
import com.studymate.jobs.*;
import com.studymate.materials.pdf.PdfFixtures;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockPart;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties={"studymate.registration.enabled=true","server.servlet.session.cookie.secure=false",
        "spring.profiles.active=local","studymate.ai.provider=fake"})
@Import({MaterialJobTestDriver.class, MaterialTextHandler.class, MaterialCleanupHandler.class})
class AttemptIT extends PostgresIntegrationTest {
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
    pdf = PdfFixtures.text("Учебные данные для проверки попыток");
    when(storage.enabled()).thenReturn(true);
    when(provider.available()).thenReturn(true);
    when(provider.model()).thenReturn("fixture-quiz");
    when(notes.available()).thenReturn(true);
    when(provider.generate(anyString(), anySet())).thenReturn(QuizFixtures.result());
    doAnswer(call -> { Files.write((Path)call.getArgument(1), pdf); return null; })
        .when(storage).fetch(anyString(), any(), anyLong(), anyString());
  }

  @Test void startsAndReplaysOneAttemptWithoutKeysAndNewKeyAllowsPractice() throws Exception {
    try (var owner = account()) {
      UUID material = material(owner), quiz = quiz(owner, material), key = UUID.randomUUID();
      var first = start(owner, quiz, key);
      UUID id = id(first);
      assertThat(first.path("status").asString()).isEqualTo("in_progress");
      assertThat(first.path("quizId").asString()).isEqualTo(quiz.toString());
      assertThat(first.path("materialId").asString()).isEqualTo(material.toString());
      assertThat(first.path("quizVersion").asInt()).isEqualTo(1);
      assertThat(first.path("questions").size()).isEqualTo(10);
      assertThat(first.size()).isEqualTo(12);
      for (String field : List.of("completedAt", "correctCount", "scorePercent", "review")) assertThat(first.path(field).isNull()).isTrue();
      assertNoKeys(first);
      assertThat(start(owner, quiz, key)).isEqualTo(first);
      assertThat(get(owner, id)).isEqualTo(first);
      for (var question : first.path("questions")) {
        assertThat(question.size()).isEqualTo(4);
        assertThat(question.path("options").size()).isEqualTo(4);
        for (var option : question.path("options")) assertThat(option.size()).isEqualTo(3);
      }
      assertThat(id(start(owner, quiz, UUID.randomUUID()))).isNotEqualTo(id);
      UUID otherQuiz = quiz(owner, material);
      assertThat(owner.http.error(post(owner, otherQuiz, key), 409)).isEqualTo("IDEMPOTENCY_KEY_REUSED");
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempts WHERE owner_id=?", Integer.class, owner.id)).isEqualTo(2);
    }
  }

  @Test void gradesPartialAnswersFromSavedKeyAndRevealsReviewOnlyAfterCommit() throws Exception {
    try (var owner = account()) {
      UUID quiz = quiz(owner, material(owner));
      var started = start(owner, quiz, UUID.randomUUID()); UUID attempt = id(started);
      var correct = answers(quiz, true);
      var selected = new ArrayList<>(correct.subList(0, 3));
      selected.addAll(answers(quiz, false).subList(3, 5));
      var result = submit(owner, attempt, selected);
      assertThat(result.path("status").asString()).isEqualTo("completed");
      assertThat(result.path("correctCount").asInt()).isEqualTo(3);
      assertThat(result.path("scorePercent").decimalValue()).isEqualByComparingTo("30.00");
      assertThat(result.path("startedAt")).isEqualTo(started.path("startedAt"));
      assertThat(Instant.parse(result.path("completedAt").asString())).isAfterOrEqualTo(Instant.parse(started.path("startedAt").asString()));
      assertThat(result.path("questions")).isEqualTo(started.path("questions"));
      assertThat(result.path("review").size()).isEqualTo(10);
      for (int i = 0; i < 10; i++) {
        var review = result.path("review").get(i);
        assertThat(review.path("questionId").asString()).isEqualTo(correct.get(i).get("questionId"));
        assertThat(review.path("correctOptionId").asString()).isEqualTo(correct.get(i).get("optionId"));
        assertThat(review.path("isCorrect").asBoolean()).isEqualTo(i < 3);
        assertThat(review.path("explanation").asString()).isNotBlank();
        assertThat(review.path("sourcePages").size()).isEqualTo(1);
        if (i >= 5) assertThat(review.path("selectedOptionId").isNull()).isTrue();
        else assertThat(review.path("selectedOptionId").asString()).isEqualTo(selected.get(i).get("optionId"));
      }
      assertThat(get(owner, attempt)).isEqualTo(result);
      assertNoKeys(owner.http.data(owner.http.send("GET", "/quizzes/" + quiz, null, null), 200));
      UUID next = id(start(owner, quiz, UUID.randomUUID()));
      assertNoKeys(get(owner, next));
      assertThat(submit(owner, next, answers(quiz, true)).path("scorePercent").asInt()).isEqualTo(100);
      verify(provider, times(1)).generate(anyString(), anySet());
    }
  }

  @Test void identicalSubmissionReplaysAcrossOrderingNullSkipsAndCompletedStart() throws Exception {
    try (var owner = account()) {
      UUID quiz = quiz(owner, material(owner)), key = UUID.randomUUID();
      UUID id = id(start(owner, quiz, key));
      var all = answers(quiz, true);
      var first = submit(owner, id, all.subList(0, 2));
      var reordered = new ArrayList<Map<String,String>>();
      reordered.add(all.get(1)); reordered.add(all.get(0));
      for (int i = 2; i < 10; i++) {
        var skip = new HashMap<String,String>(); skip.put("questionId", all.get(i).get("questionId").toUpperCase(Locale.ROOT)); skip.put("optionId", null);
        reordered.add(skip);
      }
      assertThat(submit(owner, id, reordered)).isEqualTo(first);
      assertThat(start(owner, quiz, key)).isEqualTo(first);
      assertThat(owner.http.error(sendSubmit(owner, id, all), 409)).isEqualTo("ATTEMPT_ALREADY_SUBMITTED");
      assertThat(get(owner, id)).isEqualTo(first);
      UUID empty = id(start(owner, quiz, UUID.randomUUID()));
      var zero = submit(owner, empty, List.of());
      assertThat(zero.path("scorePercent").asInt()).isZero();
      assertThat(zero.path("correctCount").asInt()).isZero();
      assertThat(submit(owner, empty, all.stream().map(a -> Map.of("questionId", a.get("questionId"))).toList())).isEqualTo(zero);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempt_answers WHERE attempt_id=?", Integer.class, empty)).isEqualTo(10);
    }
  }

  @Test void rejectsMalformedRequestsDuplicatesAndClientScoresWithoutSavingAnswers() throws Exception {
    try (var owner = account()) {
      UUID quiz = quiz(owner, material(owner)), attempt = id(start(owner, quiz, UUID.randomUUID()));
      var answer = answers(quiz, true).getFirst();
      for (String body : List.of("{}", "null", "[]", "{\"answers\":null}", "{\"answers\":{}}", "{\"answers\":[null]}",
          "{\"answers\":[{}]}", "{\"answers\":[{\"questionId\":1}]}", "{\"answers\":[{\"questionId\":\"bad\"}]}",
          "{\"answers\":[],\"scorePercent\":100}", "{\"answers\":[],\"completedAt\":\"2026-01-01T00:00:00Z\"}",
          json.writeValueAsString(Map.of("answers", Collections.nCopies(11, answer))),
          json.writeValueAsString(Map.of("answers", List.of(answer, answer))),
          json.writeValueAsString(Map.of("answers", List.of(Map.of("questionId", answer.get("questionId"), "optionId", "")))),
          json.writeValueAsString(Map.of("answers", List.of(Map.of("questionId", answer.get("questionId"), "correctOptionId", answer.get("optionId"))))))) {
        assertThat(owner.http.error(owner.http.send("POST", submitRoute(attempt), body, owner.http.token), 422)).isEqualTo("VALIDATION_FAILED");
      }
      assertThat(owner.http.error(owner.http.send("POST", submitRoute(attempt), "{", owner.http.token), 400)).isEqualTo("MALFORMED_JSON");
      assertThat(owner.http.error(owner.http.send("POST", startRoute(quiz), "{}", owner.http.token, keyHeader(UUID.randomUUID())), 400)).isEqualTo("INVALID_REQUEST");
      assertThat(owner.http.error(owner.http.send("POST", startRoute(quiz), null, owner.http.token), 400)).isEqualTo("IDEMPOTENCY_KEY_REQUIRED");
      assertThat(owner.http.error(owner.http.send("POST", startRoute(quiz), null, owner.http.token, Map.of("Idempotency-Key", "bad")), 400)).isEqualTo("INVALID_IDEMPOTENCY_KEY");
      assertThat(owner.http.error(owner.http.send("POST", startRoute(quiz) + "?x=1", null, owner.http.token, keyHeader(UUID.randomUUID())), 400)).isEqualTo("INVALID_QUERY");
      assertThat(owner.http.error(owner.http.send("POST", submitRoute(attempt) + "?x=1", Map.of("answers", List.of()), owner.http.token), 400)).isEqualTo("INVALID_QUERY");
      assertThat(owner.http.error(owner.http.send("GET", "/attempts/bad", null, null), 400)).isEqualTo("INVALID_ID");
      assertThat(owner.http.error(owner.http.send("GET", "/attempts/" + attempt + "?x=1", null, null), 400)).isEqualTo("INVALID_QUERY");
      assertThat(get(owner, attempt).path("status").asString()).isEqualTo("in_progress");
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempt_answers WHERE attempt_id=?", Integer.class, attempt)).isZero();
    }
  }

  @Test void enforcesOwnershipAndCsrfForAllRoutesWithoutLeakingKeys() throws Exception {
    try (var owner = account(); var other = account(); var anon = new AuthHttpClient(port)) {
      UUID quiz = quiz(owner, material(owner)), attempt = id(start(owner, quiz, UUID.randomUUID()));
      for (String path : List.of("/attempts/" + attempt, "/attempts"))
        assertThat(anon.error(anon.send("GET", path, null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      anon.csrf();
      assertThat(anon.error(anon.send("POST", startRoute(quiz), null, anon.token, keyHeader(UUID.randomUUID())), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      assertThat(anon.error(anon.send("POST", submitRoute(attempt), Map.of("answers", List.of()), anon.token), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      assertThat(other.http.error(other.http.send("GET", "/attempts/" + attempt, null, null), 404)).isEqualTo("ATTEMPT_NOT_FOUND");
      assertThat(other.http.error(post(other, quiz, UUID.randomUUID()), 404)).isEqualTo("QUIZ_NOT_FOUND");
      assertThat(other.http.error(sendSubmit(other, attempt, List.of()), 404)).isEqualTo("ATTEMPT_NOT_FOUND");
      assertThat(history(other, "?quizId=" + quiz).at("/meta/total").asInt()).isZero();
      assertThat(owner.http.error(owner.http.send("POST", startRoute(quiz), null, null, keyHeader(UUID.randomUUID())), 403)).isEqualTo("CSRF_INVALID");
      assertThat(owner.http.error(owner.http.send("POST", submitRoute(attempt), Map.of("answers", List.of()), null), 403)).isEqualTo("CSRF_INVALID");
      submit(owner, attempt, answers(quiz, true));
      assertThat(other.http.error(other.http.send("GET", "/attempts/" + attempt, null, null), 404)).isEqualTo("ATTEMPT_NOT_FOUND");
      assertThat(owner.http.error(owner.http.send("GET", "/attempts/" + UUID.randomUUID(), null, null), 404)).isEqualTo("ATTEMPT_NOT_FOUND");
    }
  }

  @Test void selectedOptionMustBelongToQuestionAndQuestionToExactVersion() throws Exception {
    try (var owner = account(); var other = account()) {
      UUID material = material(owner), quiz = quiz(owner, material), another = quiz(owner, material);
      UUID foreign = quiz(other, material(other)), attempt = id(start(owner, quiz, UUID.randomUUID()));
      var all = answers(quiz, true);
      for (var selection : List.of(
          Map.of("questionId", all.get(0).get("questionId"), "optionId", all.get(1).get("optionId")),
          answers(another, true).getFirst(), answers(foreign, true).getFirst(),
          Map.of("questionId", UUID.randomUUID().toString()),
          Map.of("questionId", all.get(0).get("questionId"), "optionId", UUID.randomUUID().toString()))) {
        var response = sendSubmit(owner, attempt, List.of(selection));
        assertThat(owner.http.error(response, 422)).isEqualTo("VALIDATION_FAILED"); assertNoKeys(json.readTree(response.body()));
      }
      assertThat(get(owner, attempt).path("status").asString()).isEqualTo("in_progress");
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempt_answers WHERE attempt_id=?", Integer.class, attempt)).isZero();
    }
  }

  @Test void paginatesOwnHistoryWithCombinedFiltersAndStableOrder() throws Exception {
    try (var owner = account(); var other = account()) {
      UUID material = material(owner), one = quiz(owner, material), two = quiz(owner, material);
      UUID a = id(start(owner, one, UUID.randomUUID())), b = id(start(owner, one, UUID.randomUUID())), c = id(start(owner, two, UUID.randomUUID()));
      submit(owner, a, List.of());
      var page = history(owner, "?pageSize=2");
      assertThat(page.at("/meta/total").asInt()).isEqualTo(3);
      assertThat(page.at("/data/0/id").asString()).isEqualTo(c.toString());
      assertThat(page.at("/data/1/id").asString()).isEqualTo(b.toString());
      assertThat(page.at("/data/0").size()).isEqualTo(10); assertNoKeys(page);
      assertThat(history(owner, "?pageSize=2&page=2").at("/data/0/id").asString()).isEqualTo(a.toString());
      assertThat(history(owner, "?page=9007199254740991").path("data").size()).isZero();
      assertThat(history(owner, "?materialId=" + material + "&quizId=" + one + "&status=completed").at("/meta/total").asInt()).isEqualTo(1);
      assertThat(history(owner, "?status=in_progress").at("/meta/total").asInt()).isEqualTo(2);
      assertThat(history(other, "?materialId=" + material).at("/meta/total").asInt()).isZero();
      assertThat(history(owner, "?quizId=" + UUID.randomUUID()).path("data").size()).isZero();
      for (String query : List.of("?page=0", "?pageSize=101", "?page=1&page=2", "?unknown=1", "?pageSize=x", "?status=ready", "?status=", "?quizId=", "?materialId=bad", "?quizId=" + one + "&quizId=" + one))
        assertThat(owner.http.error(owner.http.send("GET", "/attempts" + query, null, null), 400)).isEqualTo("INVALID_QUERY");
    }
  }

  @Test void concurrentStartAndIdenticalSubmitsHaveOneSavedResult() throws Exception {
    try (var owner = account(); var pool = Executors.newFixedThreadPool(2)) {
      UUID quiz = quiz(owner, material(owner)), key = UUID.randomUUID();
      var gate = new CountDownLatch(1);
      var one = pool.submit(() -> { gate.await(); return start(owner, quiz, key); });
      var two = pool.submit(() -> { gate.await(); return start(owner, quiz, key); }); gate.countDown();
      var first = one.get(10, TimeUnit.SECONDS);
      assertThat(two.get(10, TimeUnit.SECONDS)).isEqualTo(first);
      UUID attempt = id(first); var all = answers(quiz, true);
      var submitGate = new CountDownLatch(1);
      var a = pool.submit(() -> { submitGate.await(); return submit(owner, attempt, all); });
      var b = pool.submit(() -> { submitGate.await(); return submit(owner, attempt, all); }); submitGate.countDown();
      var saved = a.get(10, TimeUnit.SECONDS);
      assertThat(b.get(10, TimeUnit.SECONDS)).isEqualTo(saved);
      assertThat(saved.path("scorePercent").asInt()).isEqualTo(100);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempts WHERE owner_id=?", Integer.class, owner.id)).isEqualTo(1);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempt_answers WHERE attempt_id=?", Integer.class, attempt)).isEqualTo(10);
    }
  }

  @Test void concurrentDifferentSubmitsCannotMixOrOverwriteAnswers() throws Exception {
    try (var owner = account(); var pool = Executors.newFixedThreadPool(2)) {
      UUID quiz = quiz(owner, material(owner)), attempt = id(start(owner, quiz, UUID.randomUUID()));
      var all = answers(quiz, true); var gate = new CountDownLatch(1);
      var one = pool.submit(() -> { gate.await(); return sendSubmit(owner, attempt, all); });
      var two = pool.submit(() -> { gate.await(); return sendSubmit(owner, attempt, List.of()); }); gate.countDown();
      var a = one.get(10, TimeUnit.SECONDS); var b = two.get(10, TimeUnit.SECONDS);
      assertThat(List.of(a.statusCode(), b.statusCode())).containsExactlyInAnyOrder(200, 409);
      assertThat(owner.http.error(a.statusCode() == 409 ? a : b, 409)).isEqualTo("ATTEMPT_ALREADY_SUBMITTED");
      var saved = owner.http.data(a.statusCode() == 200 ? a : b, 200);
      assertThat(get(owner, attempt)).isEqualTo(saved);
      assertThat(saved.path("scorePercent").asInt()).isIn(0, 100);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempt_answers WHERE attempt_id=?", Integer.class, attempt)).isEqualTo(10);
    }
  }

  @Test void newGenerationCannotChangeCompletedOrRunningAttempts() throws Exception {
    try (var owner = account()) {
      UUID material = material(owner), first = quiz(owner, material);
      UUID running = id(start(owner, first, UUID.randomUUID())), completed = id(start(owner, first, UUID.randomUUID()));
      var saved = submit(owner, completed, answers(first, true)); var original = get(owner, running);
      UUID second = quiz(owner, material);
      assertThat(second).isNotEqualTo(first);
      assertThat(get(owner, completed)).isEqualTo(saved);
      assertThat(get(owner, running)).isEqualTo(original);
      assertThat(submit(owner, running, answers(first, true)).path("quizVersion").asInt()).isEqualTo(1);
      assertThat(start(owner, second, UUID.randomUUID()).path("quizVersion").asInt()).isEqualTo(2);
    }
  }

  @Test void materialDeletionHidesThenCascadesAllAttemptsAndPreventsReplay() throws Exception {
    try (var owner = account()) {
      UUID material = material(owner), quiz = quiz(owner, material), key = UUID.randomUUID();
      UUID complete = id(start(owner, quiz, key)), running = id(start(owner, quiz, UUID.randomUUID()));
      submit(owner, complete, List.of());
      var deletion = repository.delete(owner.id, material);
      for (UUID attempt : List.of(complete, running)) {
        assertThat(owner.http.error(owner.http.send("GET", "/attempts/" + attempt, null, null), 409)).isEqualTo("MATERIAL_NOT_AVAILABLE");
        assertThat(owner.http.error(sendSubmit(owner, attempt, List.of()), 409)).isEqualTo("MATERIAL_NOT_AVAILABLE");
      }
      assertThat(owner.http.error(post(owner, quiz, key), 409)).isEqualTo("MATERIAL_NOT_AVAILABLE");
      assertThat(history(owner, "").at("/meta/total").asInt()).isZero();
      driver.run(deletion.jobId(), cleanup);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempts WHERE quiz_id=?", Integer.class, quiz)).isZero();
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempt_answers WHERE quiz_id=?", Integer.class, quiz)).isZero();
      assertThat(owner.http.error(owner.http.send("GET", "/attempts/" + complete, null, null), 404)).isEqualTo("ATTEMPT_NOT_FOUND");
      assertThat(owner.http.error(post(owner, quiz, key), 404)).isEqualTo("QUIZ_NOT_FOUND");
      assertThat(repository.usage(owner.id).usedBytes()).isZero();
    }
  }

  @Test void submitRacingDeletionDoesNotDeadlockOrResurrectData() throws Exception {
    try (var owner = account(); var pool = Executors.newFixedThreadPool(2)) {
      UUID material = material(owner), quiz = quiz(owner, material), attempt = id(start(owner, quiz, UUID.randomUUID()));
      var all = answers(quiz, true); var gate = new CountDownLatch(1);
      var submission = pool.submit(() -> { gate.await(); return sendSubmit(owner, attempt, all); });
      var deletion = pool.submit(() -> { gate.await(); return repository.delete(owner.id, material); }); gate.countDown();
      var response = submission.get(10, TimeUnit.SECONDS); var removed = deletion.get(10, TimeUnit.SECONDS);
      assertThat(response.statusCode()).isIn(200, 409);
      if (response.statusCode() == 409) assertThat(owner.http.error(response, 409)).isEqualTo("MATERIAL_NOT_AVAILABLE");
      driver.run(removed.jobId(), cleanup);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempts WHERE id=?", Integer.class, attempt)).isZero();
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempt_answers WHERE attempt_id=?", Integer.class, attempt)).isZero();
    }
  }

  @Test void databaseRejectsMixedOwnersQuizzesQuestionsOptionsAndInvalidResults() throws Exception {
    try (var owner = account(); var other = account()) {
      UUID material = material(owner), quiz = quiz(owner, material), another = quiz(owner, material);
      UUID attempt = id(start(owner, quiz, UUID.randomUUID()));
      var keys = answers(quiz, true); var different = answers(another, true).getFirst();
      var first = keys.getFirst();
      assertThatThrownBy(() -> jdbc.update("UPDATE studymate.attempts SET owner_id=? WHERE id=?", other.id, attempt)).isInstanceOf(DataIntegrityViolationException.class);
      for (Object[] invalid : List.of(
          new Object[]{another, UUID.fromString(different.get("questionId")), UUID.fromString(different.get("optionId"))},
          new Object[]{quiz, UUID.fromString(different.get("questionId")), null},
          new Object[]{quiz, UUID.fromString(first.get("questionId")), UUID.fromString(keys.get(1).get("optionId"))})) {
        assertThatThrownBy(() -> jdbc.update("INSERT INTO studymate.attempt_answers(attempt_id,quiz_id,question_id,selected_option_id,is_correct) VALUES (?,?,?,?,false)",
            attempt, invalid[0], invalid[1], invalid[2])).isInstanceOf(DataIntegrityViolationException.class);
      }
      assertThatThrownBy(() -> jdbc.update("UPDATE studymate.attempts SET status='completed' WHERE id=?", attempt)).isInstanceOf(DataIntegrityViolationException.class);
      assertThatThrownBy(() -> jdbc.update("UPDATE studymate.attempts SET status='completed',completed_at=clock_timestamp(),correct_count=1,score_percent=100 WHERE id=?", attempt)).isInstanceOf(DataIntegrityViolationException.class);
      // Even a failure after answer insertion rolls back the whole transaction.
      assertThatThrownBy(() -> new TransactionTemplate(transactions).execute(status -> {
        jdbc.update("INSERT INTO studymate.attempt_answers(attempt_id,quiz_id,question_id,selected_option_id,is_correct) VALUES (?,?,?,?,true)",
            attempt, quiz, UUID.fromString(first.get("questionId")), UUID.fromString(first.get("optionId")));
        jdbc.update("UPDATE studymate.attempts SET status='completed' WHERE id=?", attempt);
        return null;
      })).isInstanceOf(DataIntegrityViolationException.class);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.attempt_answers WHERE attempt_id=?", Integer.class, attempt)).isZero();
    }
  }

  @Test void savedResultAndInProgressAttemptSurvivePackagedApplicationRestartWithoutAi() throws Exception {
    try (var owner = account()) {
      UUID quiz = quiz(owner, material(owner)), key = UUID.randomUUID();
      UUID complete = id(start(owner, quiz, key)), running = id(start(owner, quiz, UUID.randomUUID()));
      var saved = submit(owner, complete, answers(quiz, true)); var unfinished = get(owner, running);
      clearInvocations(provider, notes);
      try (var first = startApplication(); var http = new AuthHttpClient(first.port)) {
        http.cookie = owner.http.cookie;
        assertThat(http.data(http.send("GET", "/attempts/" + complete, null, null), 200)).isEqualTo(saved);
        assertThat(http.data(http.send("GET", "/attempts/" + running, null, null), 200)).isEqualTo(unfinished);
        http.csrf();
        assertThat(http.data(http.send("POST", submitRoute(running), Map.of("answers", List.of()), http.token), 200).path("scorePercent").asInt()).isZero();
      }
      try (var second = startApplication(); var http = new AuthHttpClient(second.port)) {
        http.cookie = owner.http.cookie; http.csrf();
        assertThat(http.data(http.send("POST", startRoute(quiz), null, http.token, keyHeader(key)), 201)).isEqualTo(saved);
        assertThat(http.data(http.send("POST", submitRoute(complete), Map.of("answers", answers(quiz, true)), http.token), 200)).isEqualTo(saved);
        assertThat(http.data(http.send("GET", "/attempts/" + running, null, null), 200).path("status").asString()).isEqualTo("completed");
      }
      verifyNoInteractions(provider, notes);
    }
  }

  private Running startApplication() throws Exception {
    Path log = Files.createTempFile(Path.of("target"), "attempt-restart-", ".log");
    var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
        "-jar", "target/studymate-backend-0.1.0-SNAPSHOT.jar", "--spring.profiles.active=local",
        "--server.address=127.0.0.1", "--server.port=0", "--studymate.ai.provider=disabled",
        "--studymate.r2.enabled=false", "--studymate.jobs.enabled=false", "--studymate.materials.maintenance-enabled=false")
        .redirectErrorStream(true).redirectOutput(log.toFile());
    for (String secret : List.of("STUDYMATE_OPENAI_API_KEY", "STUDYMATE_R2_ACCESS_KEY_ID", "STUDYMATE_R2_SECRET_ACCESS_KEY")) builder.environment().remove(secret);
    for (String suffix : List.of("URL", "USERNAME", "PASSWORD")) builder.environment().put("STUDYMATE_DATABASE_" + suffix, System.getenv("STUDYMATE_TEST_DATABASE_" + suffix));
    Process process = builder.start(); long until = System.nanoTime() + Duration.ofSeconds(40).toNanos();
    while (process.isAlive() && System.nanoTime() < until) {
      var match = Pattern.compile("Tomcat started on port (\\d+)").matcher(Files.readString(log));
      if (match.find()) return new Running(process, log, Integer.parseInt(match.group(1)));
      Thread.sleep(50);
    }
    process.destroyForcibly(); process.waitFor(10, TimeUnit.SECONDS);
    throw new AssertionError("Attempt test application did not start; see " + log);
  }
  private record Running(Process process, Path log, int port) implements AutoCloseable {
    public void close() throws Exception {
      if (!process.isAlive()) return;
      process.destroy();
      if (!process.waitFor(5, TimeUnit.SECONDS)) { process.destroyForcibly(); assertThat(process.waitFor(5, TimeUnit.SECONDS)).isTrue(); }
    }
  }
  private void assertNoKeys(JsonNode value) { assertThat(value.toString()).doesNotContain("correctIndex", "correctOptionId", "explanation", "sourcePages", "isCorrect", "Секретное объяснение"); }
  private record Account(UUID id, AuthHttpClient http) implements AutoCloseable { public void close() { http.close(); } }
  private Account account() throws Exception {
    var client = new AuthHttpClient(port); String email = "attempt-" + UUID.randomUUID() + "@example.com";
    UUID id = UUID.fromString(client.register(email)); client.data(client.login(email), 200); client.csrf(); return new Account(id, client);
  }
  private UUID material(Account owner) throws Exception {
    UUID subject = UUID.fromString(owner.http.data(owner.http.send("POST", "/subjects",
        Map.of("title", "Attempt " + UUID.randomUUID(), "icon", "book", "tone", "blue"), owner.http.token, keyHeader(UUID.randomUUID())), 201).path("id").asString());
    var input = new MaterialInput(subject, "Lecture", "fixture.pdf", pdf.length,
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pdf)), new MockPart("file", "fixture.pdf", pdf));
    UUID material = materials.upload(owner.id, UUID.randomUUID(), input).id();
    driver.run(repository.get(owner.id, material).processingJobId(), extraction); return material;
  }
  private UUID quiz(Account owner, UUID material) throws Exception {
    UUID job = UUID.fromString(owner.http.data(owner.http.send("POST", "/materials/" + material + "/quizzes", null, owner.http.token, keyHeader(UUID.randomUUID())), 202).path("jobId").asString());
    driver.run(job, handlers.stream().filter(h -> h.kind().equals("material.quiz")).findFirst().orElseThrow());
    return UUID.fromString(owner.http.data(owner.http.send("GET", "/jobs/" + job, null, null), 200).path("resultId").asString());
  }
  private List<Map<String,String>> answers(UUID quiz, boolean correct) {
    return jdbc.query("""
        SELECT q.id,q.correct_option_id,(SELECT o.id FROM studymate.quiz_options o
          WHERE o.question_id=q.id AND o.id<>q.correct_option_id ORDER BY o.position LIMIT 1) AS wrong
        FROM studymate.quiz_questions q WHERE q.quiz_id=? ORDER BY q.position
        """, (r,n) -> Map.of("questionId", r.getObject("id", UUID.class).toString(), "optionId", r.getObject(correct ? "correct_option_id" : "wrong", UUID.class).toString()), quiz);
  }
  private static UUID id(JsonNode value) { return UUID.fromString(value.path("id").asString()); }
  private static Map<String,String> keyHeader(UUID key) { return Map.of("Idempotency-Key", key.toString()); }
  private static String startRoute(UUID quiz) { return "/quizzes/" + quiz + "/attempts"; }
  private static String submitRoute(UUID attempt) { return "/attempts/" + attempt + "/submit"; }
  private HttpResponse<String> post(Account owner, UUID quiz, UUID key) throws Exception { return owner.http.send("POST", startRoute(quiz), null, owner.http.token, keyHeader(key)); }
  private JsonNode start(Account owner, UUID quiz, UUID key) throws Exception { return owner.http.data(post(owner, quiz, key), 201); }
  private HttpResponse<String> sendSubmit(Account owner, UUID attempt, List<Map<String,String>> answers) throws Exception { return owner.http.send("POST", submitRoute(attempt), Map.of("answers", answers), owner.http.token); }
  private JsonNode submit(Account owner, UUID attempt, List<Map<String,String>> answers) throws Exception { return owner.http.data(sendSubmit(owner, attempt, answers), 200); }
  private JsonNode get(Account owner, UUID attempt) throws Exception { return owner.http.data(owner.http.send("GET", "/attempts/" + attempt, null, null), 200); }
  private JsonNode history(Account owner, String query) throws Exception {
    var response = owner.http.send("GET", "/attempts" + query, null, null); assertThat(response.statusCode()).isEqualTo(200); return json.readTree(response.body());
  }
}
