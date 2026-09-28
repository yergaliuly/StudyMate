package com.studymate.subjects;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.reset;

import com.studymate.PostgresIntegrationTest;
import com.studymate.identity.AuthHttpClient;
import java.net.URLEncoder;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "studymate.registration.enabled=true")
@ActiveProfiles("local")
class SubjectsIT extends PostgresIntegrationTest {
  @Value("${local.server.port}") int port;
  @Autowired JdbcTemplate jdbc;
  @Autowired DataSource dataSource;
  @Autowired JsonMapper mapper;
  @MockitoSpyBean SubjectCreationRequests requests;

  @Test
  void emptyAccountAndCreationExposeOnlyServerOwnedContractFields() throws Exception {
    try (var a = account()) {
      var empty = list(a, "");
      assertThat(empty.get("data").isEmpty()).isTrue();
      assertThat(empty.at("/meta/total").asLong()).isZero();
      assertThat(empty.at("/meta/page").asInt()).isEqualTo(1);
      assertThat(empty.at("/meta/pageSize").asInt()).isEqualTo(20);
      var response = create(a, UUID.randomUUID(), Map.of("title", " \uFEFFБазы\t\nданных\u00A0 ",
          "description", " \uFEFFSQL  \n tables\u00A0 ", "icon", "database", "tone", "purple"));
      var subject = a.client().data(response, 201);
      UUID id = UUID.fromString(subject.get("id").asString());
      assertThat(subject.size()).isEqualTo(9);
      assertThat(subject.get("version").asLong()).isEqualTo(1);
      assertThat(subject.get("title").asString()).isEqualTo("Базы данных");
      assertThat(subject.get("description").asString()).isEqualTo("SQL  \n tables");
      assertThat(subject.get("lectureCount").asInt()).isZero();
      assertThat(subject.get("progressPercent").isNull()).isTrue();
      assertThat(subject.get("createdAt").asString()).endsWith("Z");
      assertThat(Instant.parse(subject.get("createdAt").asString())).isBeforeOrEqualTo(Instant.now());
      assertThat(response.headers().firstValue("Location")).hasValue("/api/v1/subjects/" + id);
      assertThat(jdbc.queryForObject("SELECT owner_id FROM studymate.subjects WHERE id = ?", UUID.class, id)).isEqualTo(a.id());
      assertThat(jdbc.queryForObject("SELECT normalized_title FROM studymate.subjects WHERE id = ?", String.class, id)).isEqualTo("базы данных");
      assertThat(list(a, "").get("data").get(0)).isEqualTo(subject);
    }
  }

  @Test
  void searchIsLiteralCaseInsensitiveAndRestrictedBeforePagination() throws Exception {
    try (var a = account(); var b = account()) {
      create(a, UUID.randomUUID(), body("SQL %_\\ Basics", "ЯЗЫКИ"));
      create(a, UUID.randomUUID(), body("Ordinary", "SQL and таблицы"));
      create(a, UUID.randomUUID(), body("Other", "nothing"));
      create(b, UUID.randomUUID(), body("SQL secret", "ЯЗЫКИ"));
      assertThat(list(a, "q=sql&pageSize=1").at("/meta/total").asInt()).isEqualTo(2);
      assertThat(list(a, "q=sql&pageSize=1").get("data").size()).isEqualTo(1);
      assertThat(list(a, "q=" + url("\uFEFFязыки\u00A0")).at("/meta/total").asInt()).isEqualTo(1);
      assertThat(list(a, "q=" + url("%_\\")).at("/meta/total").asInt()).isEqualTo(1);
      assertThat(list(a, "q=" + url("' OR 1=1 --")).at("/meta/total").asInt()).isZero();
      assertThat(list(a, "q=secret").get("data").isEmpty()).isTrue();
      assertThat(list(a, "q=" + url("  ")).at("/meta/total").asInt()).isEqualTo(3);
      var last = list(a, "q=sql&page=99&pageSize=1");
      assertThat(last.get("data").isEmpty()).isTrue();
      assertThat(last.at("/meta/total").asInt()).isEqualTo(2);
    }
  }

  @Test
  void paginationUsesCreatedAtThenUuidDescendingAndDoesNotOverflow() throws Exception {
    try (var a = account()) {
      var ids = new ArrayList<String>();
      for (int i = 0; i < 4; i++) ids.add(a.client().data(create(a, UUID.randomUUID(), body("Subject " + i, "")), 201).get("id").asString());
      jdbc.update("UPDATE studymate.subjects SET created_at = '2026-01-01T00:00:00Z' WHERE owner_id = ?", a.id());
      ids.sort(java.util.Comparator.reverseOrder());
      assertThat(list(a, "pageSize=2").get("data").get(0).get("id").asString()).isEqualTo(ids.get(0));
      assertThat(list(a, "page=2&pageSize=2").get("data").get(0).get("id").asString()).isEqualTo(ids.get(2));
      jdbc.update("UPDATE studymate.subjects SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?", UUID.fromString(ids.get(3)));
      assertThat(list(a, "").get("data").get(0).get("id").asString()).isEqualTo(ids.get(3));
      var huge = list(a, "page=9007199254740991&pageSize=100");
      assertThat(huge.get("data").isEmpty()).isTrue();
      assertThat(huge.at("/meta/total").asInt()).isEqualTo(4);
      assertThat(huge.at("/meta/page").asLong()).isEqualTo(9_007_199_254_740_991L);
    }
  }

  @Test
  void replayUsesNormalizedFieldsAndRejectsChangedDataBeforeDuplicateTitleCheck() throws Exception {
    try (var a = account(); var b = account()) {
      UUID key = UUID.randomUUID();
      var original = create(a, key, Map.of("title", "  Shared\t title  ", "icon", "book", "tone", "blue"));
      a.client().data(original, 201);
      var replay = create(a, key, "{\"tone\":\"blue\",\"description\":\"  \",\"icon\":\"book\",\"title\":\"Shared title\"}");
      a.client().data(replay, 201);
      assertThat(replay.body()).isEqualTo(original.body());
      assertThat(replay.headers().firstValue("Location")).isEqualTo(original.headers().firstValue("Location"));
      assertThat(a.client().error(create(a, key, body("Other title", "")), 409)).isEqualTo("IDEMPOTENCY_KEY_REUSED");
      var conflict = create(a, UUID.randomUUID(), body("SHARED TITLE", ""));
      assertThat(a.client().error(conflict, 409)).isEqualTo("SUBJECT_TITLE_EXISTS");
      assertThat(mapper.readTree(conflict.body()).at("/error/fieldErrors/title").asString()).isEqualTo("Выбери другое название.");
      b.client().data(create(b, key, body("Shared title", "")), 201);
      assertThat(count(a, "subjects")).isEqualTo(1);
      assertThat(count(a, "subject_creation_requests")).isEqualTo(1);
      assertThat(list(b, "").at("/meta/total").asInt()).isEqualTo(1);
    }
  }

  @Test
  void authenticationAndCsrfAreCheckedBeforeAnyReplayAndDeletedAccountCannotRead() throws Exception {
    try (var a = account(); var guest = new AuthHttpClient(port)) {
      UUID key = UUID.randomUUID();
      var body = body("Protected", "");
      a.client().data(create(a, key, body), 201);
      assertThat(guest.error(guest.send("GET", "/subjects", null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      guest.csrf();
      assertThat(guest.error(guest.send("POST", "/subjects", body, guest.token, header(key)), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      for (String token : new String[]{null, "bad", guest.token}) {
        assertThat(a.client().error(a.client().send("POST", "/subjects", body, token, header(key)), 403)).isEqualTo("CSRF_INVALID");
      }
      a.client().send("POST", "/auth/logout", null, a.client().token);
      a.client().csrf();
      assertThat(a.client().error(create(a, key, body), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      assertThat(count(a, "subjects")).isEqualTo(1);
    }
    try (var deleted = account()) {
      jdbc.update("DELETE FROM studymate.users WHERE id = ?", deleted.id());
      assertThat(deleted.client().error(deleted.client().send("GET", "/subjects", null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
    }
  }

  @Test
  void expiredResultMayBeReplacedAndCleanupNeverDeletesSubjectsOrLiveResults() throws Exception {
    try (var a = account()) {
      UUID key = UUID.randomUUID();
      a.client().data(create(a, key, body("Before expiry", "")), 201);
      expire(a, key);
      a.client().data(create(a, key, body("After expiry", "")), 201);
      assertThat(count(a, "subjects")).isEqualTo(2);
      UUID expired = UUID.randomUUID();
      a.client().data(create(a, expired, body("Keep subject", "")), 201);
      expire(a, expired);
      requests.deleteExpired();
      assertThat(count(a, "subjects")).isEqualTo(3);
      assertThat(count(a, "subject_creation_requests")).isEqualTo(1);
      a.client().data(create(a, key, body("After expiry", "")), 201);
    }
  }

  @Test
  void failureAfterWritingTheResultRollsBackBothRowsAndReleasesTheKey() throws Exception {
    try (var a = account()) {
      UUID key = UUID.randomUUID();
      doAnswer(invocation -> {
        invocation.callRealMethod();
        throw new DataAccessResourceFailureException("simulated failure after result insert");
      }).when(requests).save(eq(a.id()), eq(key), any(), any());
      try {
        assertThat(a.client().error(create(a, key, body("Atomic", "")), 503)).isEqualTo("SERVICE_UNAVAILABLE");
        assertThat(count(a, "subjects")).isZero();
        assertThat(count(a, "subject_creation_requests")).isZero();
      } finally { reset(requests); }
      a.client().data(create(a, key, body("Atomic", "")), 201);
    }
  }

  @Test
  void inProgressKeyReturnsRetryAfterWithoutWaitingForTheOtherTransaction() throws Exception {
    try (var a = account(); var connection = dataSource.getConnection()) {
      UUID key = UUID.randomUUID();
      connection.setAutoCommit(false);
      try (var statement = connection.prepareStatement("SELECT pg_try_advisory_xact_lock(?)")) {
        statement.setLong(1, SubjectCreationRequests.lockKey(a.id(), key));
        try (var result = statement.executeQuery()) { result.next(); assertThat(result.getBoolean(1)).isTrue(); }
      }
      try {
        var response = create(a, key, body("In progress", ""));
        assertThat(a.client().error(response, 409)).isEqualTo("REQUEST_IN_PROGRESS");
        assertThat(response.headers().firstValue("Retry-After")).hasValue("1");
        assertThat(count(a, "subjects")).isZero();
      } finally { connection.rollback(); }
      a.client().data(create(a, key, body("In progress", "")), 201);
    }
  }

  @Test
  void concurrentSameKeyRequestsCreateOnceAndNewKeysCannotBypassTitleUniqueness() throws Exception {
    for (boolean sameKey : new boolean[]{true, false}) {
      try (var a = account(); var other = new AuthHttpClient(port); var executor = Executors.newFixedThreadPool(2)) {
        other.cookie = a.client().cookie; other.token = a.client().token;
        UUID firstKey = UUID.randomUUID();
        UUID secondKey = sameKey ? firstKey : UUID.randomUUID();
        var barrier = new CyclicBarrier(2);
        var first = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return create(a, firstKey, body("Race title", "")); });
        var second = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return other.send("POST", "/subjects", body("Race title", ""), other.token, header(secondKey)); });
        var responses = List.of(first.get(15, TimeUnit.SECONDS), second.get(15, TimeUnit.SECONDS));
        assertThat(responses.stream().filter(r -> r.statusCode() == 201).count()).isGreaterThanOrEqualTo(1);
        for (var response : responses) {
          if (response.statusCode() != 201) assertThat(a.client().error(response, 409))
              .isEqualTo(sameKey ? "REQUEST_IN_PROGRESS" : "SUBJECT_TITLE_EXISTS");
        }
        assertThat(count(a, "subjects")).isEqualTo(1);
        assertThat(count(a, "subject_creation_requests")).isEqualTo(1);
        if (sameKey) {
          var original = responses.stream().filter(r -> r.statusCode() == 201).findFirst().orElseThrow();
          assertThat(create(a, firstKey, body("Race title", "")).body()).isEqualTo(original.body());
        } else assertThat(responses.stream().filter(r -> r.statusCode() == 201).count()).isEqualTo(1);
      }
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"page=0", "page=-1", "page=1.5", "page=", "pageSize=0", "pageSize=101",
      "sort=title", "ownerId=forged", "page=1&page=2", "q=a&q=b", "q=%00"})
  void invalidQueryIs400(String query) throws Exception {
    try (var a = account()) {
      assertThat(a.client().error(a.client().send("GET", "/subjects?" + query, null, null), 400)).isEqualTo("INVALID_QUERY");
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"{}", "null", "[]", "{\"title\":123,\"icon\":\"book\",\"tone\":\"blue\"}",
      "{\"title\":\"Valid\",\"description\":null,\"icon\":\"book\",\"tone\":\"blue\"}",
      "{\"title\":\"Valid\",\"description\":true,\"icon\":\"book\",\"tone\":\"blue\"}",
      "{\"title\":\"Valid\",\"icon\":\"Book\",\"tone\":\"blue\"}",
      "{\"title\":\"Valid\",\"icon\":\"book\",\"tone\":\"pink\"}",
      "{\"title\":\"Valid\",\"icon\":\"book\",\"tone\":\"blue\",\"ownerId\":\"forged\"}",
      "{\"title\":\"Valid\",\"icon\":\"book\",\"tone\":\"blue\",\"lectureCount\":42}",
      "{\"title\":\"Valid\",\"icon\":\"book\",\"tone\":\"blue\",\"id\":\"forged\"}",
      "{\"title\":\"Valid\",\"icon\":\"book\",\"tone\":\"blue\",\"version\":1}"})
  void invalidBodiesNeverCreateOrReserveAResult(String body) throws Exception {
    try (var a = account()) {
      UUID key = UUID.randomUUID();
      assertThat(a.client().error(create(a, key, body), 422)).isEqualTo("VALIDATION_FAILED");
      assertThat(count(a, "subjects")).isZero();
      assertThat(count(a, "subject_creation_requests")).isZero();
      a.client().data(create(a, key, body("Corrected", "")), 201);
    }
  }

  @Test
  void missingInvalidAndDuplicateKeysAre400AndTitleConflictDoesNotReserveKey() throws Exception {
    try (var a = account()) {
      assertThat(a.client().error(a.client().send("POST", "/subjects", body("Valid", ""), a.client().token), 400))
          .isEqualTo("IDEMPOTENCY_KEY_REQUIRED");
      for (String key : new String[]{"", "invalid", "1-1-1-1-1", UUID.randomUUID() + "," + UUID.randomUUID()}) {
        assertThat(a.client().error(a.client().send("POST", "/subjects", body("Valid", ""), a.client().token,
            Map.of("Idempotency-Key", key)), 400)).isEqualTo("INVALID_IDEMPOTENCY_KEY");
      }
      a.client().data(create(a, UUID.randomUUID(), body("Valid", "")), 201);
      UUID key = UUID.randomUUID();
      assertThat(a.client().error(create(a, key, body("VALID", "")), 409)).isEqualTo("SUBJECT_TITLE_EXISTS");
      a.client().data(create(a, key, body("Another title", "")), 201);
      assertThat(count(a, "subjects")).isEqualTo(2);
      assertThat(count(a, "subject_creation_requests")).isEqualTo(2);
    }
  }

  private record Account(AuthHttpClient client, UUID id) implements AutoCloseable {
    @Override public void close() { client.close(); }
  }
  private Account account() throws Exception {
    var client = new AuthHttpClient(port);
    try {
      String email = "subjects-" + UUID.randomUUID() + "@example.com";
      UUID id = UUID.fromString(client.register(email));
      client.data(client.login(email), 200); client.csrf();
      return new Account(client, id);
    } catch (Exception | AssertionError failure) { client.close(); throw failure; }
  }
  private static Map<String, String> body(String title, String description) {
    return Map.of("title", title, "description", description, "icon", "book", "tone", "blue");
  }
  private static Map<String, String> header(UUID key) { return Map.of("Idempotency-Key", key.toString()); }
  private HttpResponse<String> create(Account a, UUID key, Object body) throws Exception {
    return a.client().send("POST", "/subjects", body, a.client().token, header(key));
  }
  private JsonNode list(Account a, String query) throws Exception {
    var response = a.client().send("GET", "/subjects" + (query.isEmpty() ? "" : "?" + query), null, null);
    a.client().data(response, 200);
    return mapper.readTree(response.body());
  }
  private long count(Account a, String table) {
    return jdbc.queryForObject("SELECT count(*) FROM studymate." + table + " WHERE owner_id = ?", Long.class, a.id());
  }
  private void expire(Account a, UUID key) {
    jdbc.update("UPDATE studymate.subject_creation_requests SET completed_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE owner_id = ? AND request_key = ?", a.id(), key);
  }
  private static String url(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
}
