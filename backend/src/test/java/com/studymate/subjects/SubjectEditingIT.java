package com.studymate.subjects;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.reset;

import com.studymate.PostgresIntegrationTest;
import com.studymate.identity.AuthHttpClient;
import java.net.http.HttpResponse;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "studymate.registration.enabled=true")
@ActiveProfiles("local")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SubjectEditingIT extends PostgresIntegrationTest {
  @Value("${local.server.port}") int port;
  @Autowired JdbcTemplate jdbc;
  @Autowired DataSource dataSource;
  @Autowired JsonMapper mapper;
  @MockitoSpyBean SubjectRepository repository;

  // Material storage is stage 8. This explicitly test-only table verifies the real PostgreSQL
  // FK deletion boundary, including pending cleanup and races, without adding a fake production module.
  @BeforeAll
  void createMaterialReferenceFixture() {
    jdbc.execute("""
        CREATE TABLE studymate.stage6_material_references_test (
          id UUID PRIMARY KEY, subject_id UUID NOT NULL REFERENCES studymate.subjects(id) ON DELETE RESTRICT,
          state TEXT NOT NULL)
        """);
  }

  @AfterAll
  void removeMaterialReferenceFixture() {
    jdbc.execute("DROP TABLE studymate.stage6_material_references_test");
  }

  @Test
  void readAndPartialUpdateKeepOmittedFieldsAndReturnTheNewVersion() throws Exception {
    try (var a = account()) {
      var created = create(a, "Initial");
      String id = created.get("id").asString();
      assertThat(get(a, id)).isEqualTo(created);
      assertThat(get(a, id.toUpperCase(java.util.Locale.ROOT))).isEqualTo(created);
      var changed = a.client().data(patch(a, id, Map.of("version", 1, "title", " \uFEFFНовая\t тема\u00A0 ")), 200);
      assertThat(changed.get("version").asLong()).isEqualTo(2);
      assertThat(changed.get("title").asString()).isEqualTo("Новая тема");
      for (String field : List.of("id", "createdAt", "description", "icon", "tone", "lectureCount", "progressPercent")) {
        assertThat(changed.get(field)).isEqualTo(created.get(field));
      }
      var cleared = a.client().data(patch(a, id, Map.of("version", 2, "description", " \u00A0 ",
          "icon", "languages", "tone", "green")), 200);
      assertThat(cleared.get("description").asString()).isEmpty();
      assertThat(cleared.get("title")).isEqualTo(changed.get("title"));
      assertThat(cleared.get("icon").asString()).isEqualTo("languages");
      assertThat(cleared.get("tone").asString()).isEqualTo("green");
      assertThat(cleared.get("version").asLong()).isEqualTo(3);
      var same = a.client().data(patch(a, id, Map.of("version", 3, "title", "Новая тема")), 200);
      assertThat(same.get("version").asLong()).isEqualTo(4);
      assertThat(a.client().data(a.client().send("GET", "/subjects?q=initial", null, null), 200).isEmpty()).isTrue();
      assertThat(a.client().data(a.client().send("GET", "/subjects", null, null), 200).get(0)).isEqualTo(same);
      a.client().data(patch(a, id, Map.of("version", 4, "description", " SQL  \n INDEX ")), 200);
      assertThat(a.client().data(a.client().send("GET", "/subjects?q=index", null, null), 200).get(0)
          .get("description").asString()).isEqualTo("SQL  \n INDEX");
    }
  }

  @Test
  void staleAndDuplicateTitleConflictsDoNotModifyAnyFieldsOrVersion() throws Exception {
    try (var a = account(); var b = account()) {
      create(a, "Taken title");
      create(b, "Other owner title");
      var original = create(a, "Editable");
      String id = original.get("id").asString();
      var duplicate = patch(a, id, Map.of("version", 1, "title", " TAKEN\tTITLE ", "tone", "green"));
      assertThat(a.client().error(duplicate, 409)).isEqualTo("SUBJECT_TITLE_EXISTS");
      assertThat(mapper.readTree(duplicate.body()).at("/error/fieldErrors/title").asString()).isNotBlank();
      assertThat(get(a, id)).isEqualTo(original);
      var updated = a.client().data(patch(a, id, Map.of("version", 1, "title", "Other owner title")), 200);
      assertThat(a.client().error(patch(a, id, Map.of("version", 1, "title", "Taken title")), 409))
          .isEqualTo("SUBJECT_VERSION_CONFLICT");
      assertThat(a.client().error(patch(a, id, Map.of("version", 99, "tone", "purple")), 409))
          .isEqualTo("SUBJECT_VERSION_CONFLICT");
      assertThat(get(a, id)).isEqualTo(updated);
      assertThat(updated.get("version").asLong()).isEqualTo(2);
    }
  }

  @Test
  void foreignAndMissingSubjectsHaveIdenticalResponsesForAllOperations() throws Exception {
    try (var a = account(); var b = account()) {
      var original = create(a, "Private");
      String id = original.get("id").asString();
      for (String verb : List.of("GET", "PATCH", "DELETE")) {
        Object body = verb.equals("PATCH") ? Map.of("version", 1, "title", "Stolen") : null;
        var foreign = b.client().send(verb, "/subjects/" + id, body, b.client().token);
        var missing = b.client().send(verb, "/subjects/" + UUID.randomUUID(), body, b.client().token);
        assertThat(b.client().error(foreign, 404)).isEqualTo("SUBJECT_NOT_FOUND");
        assertThat(missing.statusCode()).isEqualTo(404);
        assertThat(foreign.body()).isEqualTo(missing.body());
      }
      assertThat(get(a, id)).isEqualTo(original);
    }
  }

  @Test
  void sessionAndCsrfProtectAllOperationsAndDeletedAccountsAreRejected() throws Exception {
    try (var a = account(); var guest = new AuthHttpClient(port)) {
      var original = create(a, "Protected");
      String path = "/subjects/" + original.get("id").asString();
      guest.csrf();
      for (String verb : List.of("GET", "PATCH", "DELETE")) {
        Object body = verb.equals("PATCH") ? Map.of("version", 1, "title", "Changed") : null;
        assertThat(guest.error(guest.send(verb, path, body, guest.token), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
        if (!verb.equals("GET")) {
          for (String token : new String[]{null, "bad", guest.token}) {
            assertThat(a.client().error(a.client().send(verb, path, body, token), 403)).isEqualTo("CSRF_INVALID");
          }
        }
      }
      assertThat(get(a, original.get("id").asString())).isEqualTo(original);
    }
    for (String verb : List.of("GET", "PATCH", "DELETE")) {
      try (var deleted = account()) {
        jdbc.update("DELETE FROM studymate.users WHERE id = ?", deleted.id());
        Object body = verb.equals("PATCH") ? Map.of("version", 1, "title", "Changed") : null;
        assertThat(deleted.client().error(deleted.client().send(verb, "/subjects/" + UUID.randomUUID(), body,
            deleted.client().token), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      }
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"not-a-uuid", "1-1-1-1-1", "00000000-0000-0000-0000-00000000000g"})
  void malformedIdsAndUnsupportedQueryNeverReachMutation(String id) throws Exception {
    try (var a = account()) {
      for (String verb : List.of("GET", "PATCH", "DELETE")) {
        Object body = verb.equals("PATCH") ? Map.of("version", 1, "title", "Changed") : null;
        assertThat(a.client().error(a.client().send(verb, "/subjects/" + id, body, a.client().token), 400)).isEqualTo("INVALID_ID");
        assertThat(a.client().error(a.client().send(verb, "/subjects/" + UUID.randomUUID() + "?ownerId=forged",
            body, a.client().token), 400)).isEqualTo("INVALID_QUERY");
      }
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"null", "[]", "{}", "{\"version\":1}", "{\"title\":\"Changed\"}",
      "{\"version\":null,\"title\":\"Changed\"}", "{\"version\":0,\"title\":\"Changed\"}",
      "{\"version\":-1,\"title\":\"Changed\"}", "{\"version\":1.0,\"title\":\"Changed\"}",
      "{\"version\":\"1\",\"title\":\"Changed\"}", "{\"version\":true,\"title\":\"Changed\"}",
      "{\"version\":9007199254740992,\"title\":\"Changed\"}",
      "{\"version\":1,\"title\":null}", "{\"version\":1,\"description\":null}",
      "{\"version\":1,\"icon\":null}", "{\"version\":1,\"tone\":null}",
      "{\"version\":1,\"title\":123}", "{\"version\":1,\"description\":true}",
      "{\"version\":1,\"title\":\" A \"}", "{\"version\":1,\"title\":\"AB\\u0000\"}",
      "{\"version\":1,\"description\":\"\\uD800\"}", "{\"version\":1,\"icon\":\"Book\"}",
      "{\"version\":1,\"tone\":\"pink\"}", "{\"version\":1,\"ownerId\":\"forged\"}",
      "{\"version\":1,\"lectureCount\":42}", "{\"version\":1,\"id\":\"forged\"}",
      "{\"version\":1,\"createdAt\":\"2026-01-01T00:00:00Z\"}", "{\"version\":1,\"progressPercent\":100}"})
  void invalidPatchesNeverChangeTheSubject(String body) throws Exception {
    try (var a = account()) {
      var original = create(a, "Unchanged");
      String id = original.get("id").asString();
      assertThat(a.client().error(patch(a, id, body), 422)).isEqualTo("VALIDATION_FAILED");
      assertThat(get(a, id)).isEqualTo(original);
    }
  }

  @Test
  void malformedJsonAndUtf16LimitsAreValidatedBeforeWriting() throws Exception {
    try (var a = account()) {
      var original = create(a, "Limits");
      String id = original.get("id").asString();
      assertThat(a.client().error(patch(a, id, "{\"version\":1,"), 400)).isEqualTo("MALFORMED_JSON");
      for (var body : List.of(Map.of("version", 1, "title", "😀".repeat(31)),
          Map.of("version", 1, "description", "😀".repeat(81)))) {
        assertThat(a.client().error(patch(a, id, body), 422)).isEqualTo("VALIDATION_FAILED");
      }
      assertThat(get(a, id)).isEqualTo(original);
      var valid = a.client().data(patch(a, id, Map.of("version", 1, "title", "😀".repeat(30),
          "description", "😀".repeat(80))), 200);
      assertThat(valid.get("version").asLong()).isEqualTo(2);
    }
  }

  @Test
  void concurrentEditsAcceptOnlyOneWriterPerVersion() throws Exception {
    try (var a = account(); var other = new AuthHttpClient(port); var executor = Executors.newFixedThreadPool(2)) {
      String id = create(a, "Race").get("id").asString();
      other.cookie = a.client().cookie; other.token = a.client().token;
      var barrier = new CyclicBarrier(2);
      var first = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return patch(a, id, Map.of("version", 1, "title", "First")); });
      var second = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return other.send("PATCH", "/subjects/" + id,
          Map.of("version", 1, "title", "Second"), other.token); });
      var responses = List.of(first.get(15, TimeUnit.SECONDS), second.get(15, TimeUnit.SECONDS));
      assertThat(responses.stream().map(HttpResponse::statusCode)).containsExactlyInAnyOrder(200, 409);
      var winner = responses.stream().filter(r -> r.statusCode() == 200).findFirst().orElseThrow();
      var loser = responses.stream().filter(r -> r.statusCode() == 409).findFirst().orElseThrow();
      assertThat(a.client().error(loser, 409)).isEqualTo("SUBJECT_VERSION_CONFLICT");
      assertThat(get(a, id)).isEqualTo(a.client().data(winner, 200));
      assertThat(get(a, id).get("version").asLong()).isEqualTo(2);
    }
  }

  @Test
  void concurrentRenamesToSameTitleRespectDatabaseUniqueness() throws Exception {
    try (var a = account(); var other = new AuthHttpClient(port); var executor = Executors.newFixedThreadPool(2)) {
      String firstId = create(a, "First").get("id").asString();
      String secondId = create(a, "Second").get("id").asString();
      other.cookie = a.client().cookie; other.token = a.client().token;
      var barrier = new CyclicBarrier(2);
      var first = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return patch(a, firstId, Map.of("version", 1, "title", "Shared")); });
      var second = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return other.send("PATCH", "/subjects/" + secondId,
          Map.of("version", 1, "title", "SHARED"), other.token); });
      var responses = List.of(first.get(15, TimeUnit.SECONDS), second.get(15, TimeUnit.SECONDS));
      assertThat(responses.stream().map(HttpResponse::statusCode)).containsExactlyInAnyOrder(200, 409);
      assertThat(a.client().error(responses.stream().filter(r -> r.statusCode() == 409).findFirst().orElseThrow(), 409))
          .isEqualTo("SUBJECT_TITLE_EXISTS");
      assertThat(List.of(get(a, firstId).get("version").asLong(), get(a, secondId).get("version").asLong()))
          .containsExactlyInAnyOrder(1L, 2L);
    }
  }

  @Test
  void concurrentEditAndDeleteNeverResurrectTheSubject() throws Exception {
    try (var a = account(); var other = new AuthHttpClient(port); var executor = Executors.newFixedThreadPool(2)) {
      String id = create(a, "Edit delete race").get("id").asString();
      other.cookie = a.client().cookie; other.token = a.client().token;
      var barrier = new CyclicBarrier(2);
      var edit = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return patch(a, id, Map.of("version", 1, "title", "Changed")); });
      var deletion = executor.submit(() -> { barrier.await(5, TimeUnit.SECONDS); return other.send("DELETE", "/subjects/" + id, null, other.token); });
      assertThat(deletion.get(15, TimeUnit.SECONDS).statusCode()).isEqualTo(204);
      var edited = edit.get(15, TimeUnit.SECONDS);
      assertThat(edited.statusCode()).isIn(200, 404);
      if (edited.statusCode() == 404) assertThat(a.client().error(edited, 404)).isEqualTo("SUBJECT_NOT_FOUND");
      else assertThat(a.client().data(edited, 200).get("version").asLong()).isEqualTo(2);
      assertThat(a.client().error(a.client().send("GET", "/subjects/" + id, null, null), 404)).isEqualTo("SUBJECT_NOT_FOUND");
    }
  }

  @Test
  void emptyDeleteIsFinalAndCreationReplayNeverRevertsOrResurrectsTheSubject() throws Exception {
    try (var a = account()) {
      var headers = Map.of("Idempotency-Key", UUID.randomUUID().toString());
      var input = Map.of("title", "Replay", "icon", "book", "tone", "blue");
      var original = a.client().send("POST", "/subjects", input, a.client().token, headers);
      String id = a.client().data(original, 201).get("id").asString();
      var changed = a.client().data(patch(a, id, Map.of("version", 1, "title", "Renamed")), 200);
      var replay = a.client().send("POST", "/subjects", input, a.client().token, headers);
      assertThat(replay.statusCode()).isEqualTo(201);
      assertThat(replay.body()).isEqualTo(original.body());
      assertThat(get(a, id)).isEqualTo(changed);
      var deleted = a.client().send("DELETE", "/subjects/" + id, null, a.client().token);
      assertThat(deleted.statusCode()).isEqualTo(204);
      assertThat(deleted.body()).isEmpty();
      assertThat(a.client().data(a.client().send("GET", "/subjects", null, null), 200).isEmpty()).isTrue();
      for (String verb : List.of("GET", "PATCH", "DELETE")) {
        assertThat(a.client().error(a.client().send(verb, "/subjects/" + id,
            verb.equals("PATCH") ? Map.of("version", 2, "title", "Restore") : null, a.client().token), 404))
            .isEqualTo("SUBJECT_NOT_FOUND");
      }
      var afterDelete = a.client().send("POST", "/subjects", input, a.client().token, headers);
      assertThat(afterDelete.statusCode()).isEqualTo(201);
      assertThat(afterDelete.body()).isEqualTo(original.body());
      assertThat(afterDelete.headers().firstValue("Location")).isEqualTo(original.headers().firstValue("Location"));
      assertThat(a.client().error(a.client().send("GET", "/subjects/" + id, null, null), 404)).isEqualTo("SUBJECT_NOT_FOUND");
      assertThat(create(a, "Replay").get("id").asString()).isNotEqualTo(id);
    }
  }

  @Test
  void legacyCreationReplayWithoutVersionStaysByteForByteIdentical() throws Exception {
    try (var a = account()) {
      var input = Map.of("title", "Legacy", "icon", "book", "tone", "blue");
      UUID key = UUID.randomUUID();
      var headers = Map.of("Idempotency-Key", key.toString());
      var created = a.client().send("POST", "/subjects", input, a.client().token, headers);
      var data = a.client().data(created, 201);
      var legacy = mapper.readTree(created.body());
      ((tools.jackson.databind.node.ObjectNode) legacy.get("data")).remove("version");
      String originalV4Body = mapper.writeValueAsString(legacy);
      jdbc.update("UPDATE studymate.subject_creation_requests SET response_body = ? WHERE owner_id = ? AND request_key = ?",
          originalV4Body, a.id(), key);
      var replay = a.client().send("POST", "/subjects", input, a.client().token, headers);
      assertThat(replay.statusCode()).isEqualTo(201);
      assertThat(replay.body()).isEqualTo(originalV4Body);
      assertThat(get(a, data.get("id").asString()).get("version").asLong()).isEqualTo(1);
    }
  }

  @Test
  void databaseFailureAfterUpdateOrDeleteRollsBackTheWholeMutation() throws Exception {
    try (var a = account()) {
      var original = create(a, "Atomic");
      UUID id = UUID.fromString(original.get("id").asString());
      doAnswer(invocation -> { invocation.callRealMethod(); throw new DataAccessResourceFailureException("test failure"); })
          .when(repository).update(eq(a.id()), eq(id), any());
      try {
        assertThat(a.client().error(patch(a, id.toString(), Map.of("version", 1, "title", "Lost")), 503)).isEqualTo("SERVICE_UNAVAILABLE");
        assertThat(get(a, id.toString())).isEqualTo(original);
      } finally { reset(repository); }
      doAnswer(invocation -> { invocation.callRealMethod(); throw new DataAccessResourceFailureException("test failure"); })
          .when(repository).delete(a.id(), id);
      try {
        assertThat(a.client().error(a.client().send("DELETE", "/subjects/" + id, null, a.client().token), 503)).isEqualTo("SERVICE_UNAVAILABLE");
        assertThat(get(a, id.toString())).isEqualTo(original);
      } finally { reset(repository); }
    }
  }

  @Test
  void materialReferencesIncludingProcessingAndCleanupBlockDeletionWithoutLeakingToOtherOwners() throws Exception {
    try (var a = account(); var other = account()) {
      String id = create(a, "Nonempty").get("id").asString();
      UUID material = UUID.randomUUID();
      try {
        jdbc.update("INSERT INTO studymate.stage6_material_references_test VALUES (?, ?, 'processing')", material, UUID.fromString(id));
        for (String state : List.of("processing", "ready", "failed", "deleting")) {
          jdbc.update("UPDATE studymate.stage6_material_references_test SET state = ? WHERE id = ?", state, material);
          assertThat(a.client().error(a.client().send("DELETE", "/subjects/" + id, null, a.client().token), 409)).isEqualTo("SUBJECT_NOT_EMPTY");
          assertThat(other.client().error(other.client().send("DELETE", "/subjects/" + id, null, other.client().token), 404)).isEqualTo("SUBJECT_NOT_FOUND");
          assertThat(get(a, id).get("version").asLong()).isEqualTo(1);
        }
      } finally { jdbc.update("DELETE FROM studymate.stage6_material_references_test WHERE id = ?", material); }
      assertThat(a.client().send("DELETE", "/subjects/" + id, null, a.client().token).statusCode()).isEqualTo(204);
    }
  }

  @Test
  void deletionWaitsForConcurrentMaterialInsertAndThenReturnsNotEmpty() throws Exception {
    try (var a = account(); var connection = dataSource.getConnection(); var executor = Executors.newSingleThreadExecutor()) {
      UUID id = UUID.fromString(create(a, "Insert race").get("id").asString());
      UUID material = UUID.randomUUID();
      connection.setAutoCommit(false);
      try {
        try (var insert = connection.prepareStatement("INSERT INTO studymate.stage6_material_references_test VALUES (?, ?, 'processing')")) {
          insert.setObject(1, material); insert.setObject(2, id); insert.executeUpdate();
        }
        var deletion = executor.submit(() -> a.client().send("DELETE", "/subjects/" + id, null, a.client().token));
        awaitBlockedQuery("DELETE FROM studymate.subjects");
        connection.commit();
        assertThat(a.client().error(deletion.get(15, TimeUnit.SECONDS), 409)).isEqualTo("SUBJECT_NOT_EMPTY");
      } finally {
        connection.rollback();
        jdbc.update("DELETE FROM studymate.stage6_material_references_test WHERE id = ?", material);
      }
      assertThat(get(a, id.toString()).get("id").asString()).isEqualTo(id.toString());
    }
  }

  @Test
  void materialInsertCannotCommitAfterConcurrentSubjectDeletion() throws Exception {
    try (var a = account(); var connection = dataSource.getConnection(); var executor = Executors.newSingleThreadExecutor()) {
      UUID id = UUID.fromString(create(a, "Delete race").get("id").asString());
      connection.setAutoCommit(false);
      try {
        try (var deletion = connection.prepareStatement("DELETE FROM studymate.subjects WHERE owner_id = ? AND id = ?")) {
          deletion.setObject(1, a.id()); deletion.setObject(2, id); assertThat(deletion.executeUpdate()).isEqualTo(1);
        }
        var insert = executor.submit(() -> {
          try {
            jdbc.update("INSERT INTO studymate.stage6_material_references_test VALUES (?, ?, 'processing')", UUID.randomUUID(), id);
            return "unexpected success";
          } catch (DataIntegrityViolationException exception) {
            return ((SQLException) exception.getMostSpecificCause()).getSQLState();
          }
        });
        awaitBlockedQuery("INSERT INTO studymate.stage6_material_references_test");
        connection.commit();
        assertThat(insert.get(15, TimeUnit.SECONDS)).isEqualTo("23503");
      } finally { connection.rollback(); }
      assertThat(a.client().error(a.client().send("GET", "/subjects/" + id, null, null), 404)).isEqualTo("SUBJECT_NOT_FOUND");
    }
  }

  private void awaitBlockedQuery(String prefix) throws Exception {
    long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
    while (System.nanoTime() < deadline) {
      if (Boolean.TRUE.equals(jdbc.queryForObject("""
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid()
              AND datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ?)
          """, Boolean.class, prefix + "%"))) return;
      Thread.sleep(25);
    }
    throw new AssertionError("Expected concurrent statement to wait on the database lock");
  }

  private record Account(AuthHttpClient client, UUID id) implements AutoCloseable {
    @Override public void close() { client.close(); }
  }
  private Account account() throws Exception {
    var client = new AuthHttpClient(port);
    try {
      String email = "editing-" + UUID.randomUUID() + "@example.com";
      UUID id = UUID.fromString(client.register(email));
      client.data(client.login(email), 200); client.csrf();
      return new Account(client, id);
    } catch (Exception | AssertionError failure) { client.close(); throw failure; }
  }
  private JsonNode create(Account a, String title) throws Exception {
    return a.client().data(a.client().send("POST", "/subjects",
        Map.of("title", title, "description", "Keep description", "icon", "book", "tone", "blue"), a.client().token,
        Map.of("Idempotency-Key", UUID.randomUUID().toString())), 201);
  }
  private JsonNode get(Account a, String id) throws Exception {
    return a.client().data(a.client().send("GET", "/subjects/" + id, null, null), 200);
  }
  private HttpResponse<String> patch(Account a, String id, Object body) throws Exception {
    return a.client().send("PATCH", "/subjects/" + id, body, a.client().token);
  }
}
