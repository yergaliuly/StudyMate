package com.studymate.attempts;

import com.studymate.common.api.ApiException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

@Repository
class AttemptRepository {
  private final JdbcClient jdbc;
  private final JsonMapper json;
  AttemptRepository(JdbcClient jdbc, JsonMapper json) { this.jdbc = jdbc; this.json = json; }

  record Info(UUID id, UUID quizId, UUID materialId, long quizVersion, String status, int questionCount,
              Instant startedAt, Instant completedAt, Integer correctCount, BigDecimal scorePercent) {}
  record Option(UUID id, int position, String text) {}
  record Question(UUID id, int position, String text, List<Option> options) {}
  record Review(UUID questionId, UUID selectedOptionId, UUID correctOptionId, boolean isCorrect,
                String explanation, List<Integer> sourcePages) {}
  record View(UUID id, UUID quizId, UUID materialId, long quizVersion, String status, int questionCount,
              Instant startedAt, Instant completedAt, Integer correctCount, BigDecimal scorePercent,
              List<Question> questions, List<Review> review) {}
  record Meta(long page, int pageSize, long total) {}
  record Page(List<Info> data, Meta meta) {}
  private record Key(UUID question, UUID correctOption) {}
  private static final String COLUMNS = """
      a.id,a.quiz_id,q.material_id,q.version AS quiz_version,a.status,a.question_count,
      a.started_at,a.completed_at,a.correct_count,a.score_percent
      """;
  private static final String FROM = """
      FROM studymate.attempts a
      JOIN studymate.quizzes q ON q.id=a.quiz_id AND q.owner_id=a.owner_id
      JOIN studymate.materials m ON m.id=q.material_id AND m.owner_id=q.owner_id
      JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
      """;

  @Transactional(timeout = 10)
  public View start(UUID owner, UUID quiz, UUID key) {
    // Same account lock as material cleanup; never acquire a job lock while holding it.
    lockOwner(owner);
    int count = jdbc.sql("""
        SELECT q.question_count,o.state FROM studymate.quizzes q
        JOIN studymate.materials m ON m.id=q.material_id AND m.owner_id=q.owner_id
        JOIN studymate.material_objects o ON o.id=m.id AND o.owner_id=m.owner_id
        WHERE q.id=:quiz AND q.owner_id=:owner FOR UPDATE OF o,m,q
        """).param("quiz", quiz).param("owner", owner).query((r,n) -> {
          requireStored(r.getString("state")); return r.getInt("question_count");
        }).optional().orElseThrow(() -> error(HttpStatus.NOT_FOUND, "QUIZ_NOT_FOUND", "Тест не найден."));
    var prior = jdbc.sql("SELECT id,quiz_id FROM studymate.attempts WHERE owner_id=:owner AND operation_key=:key")
        .param("owner", owner).param("key", key).query((r,n) -> {
          if (!quiz.equals(r.getObject("quiz_id", UUID.class)))
            throw error(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_REUSED", "Ключ уже использован для другого теста.");
          return r.getObject("id", UUID.class);
        }).optional();
    if (prior.isPresent()) return view(load(owner, prior.get(), false));
    UUID id = UUID.randomUUID();
    jdbc.sql("""
        INSERT INTO studymate.attempts(id,owner_id,quiz_id,operation_key,question_count)
        VALUES (:id,:owner,:quiz,:key,:count)
        """).param("id", id).param("owner", owner).param("quiz", quiz).param("key", key).param("count", count).update();
    return view(load(owner, id, false));
  }

  @Transactional(timeout = 10)
  public View submit(UUID owner, UUID id, Map<UUID, UUID> selections) {
    lockOwner(owner);
    Info attempt = load(owner, id, true);
    var keys = jdbc.sql("SELECT id,correct_option_id FROM studymate.quiz_questions WHERE quiz_id=:quiz ORDER BY position")
        .param("quiz", attempt.quizId()).query((r,n) -> new Key(r.getObject("id", UUID.class), r.getObject("correct_option_id", UUID.class))).list();
    if (keys.size() != attempt.questionCount()) throw new IllegalStateException("Incomplete saved quiz");
    var normalized = new HashMap<UUID, UUID>();
    keys.forEach(key -> normalized.put(key.question(), null));
    if (!normalized.keySet().containsAll(selections.keySet())) throw SubmitRequest.invalid("Вопрос не принадлежит этому тесту.");
    var optionQuestions = new HashMap<UUID, UUID>();
    jdbc.sql("""
        SELECT v.id,v.question_id FROM studymate.quiz_options v
        JOIN studymate.quiz_questions q ON q.id=v.question_id WHERE q.quiz_id=:quiz
        """).param("quiz", attempt.quizId()).query((r,n) -> {
          optionQuestions.put(r.getObject("id", UUID.class), r.getObject("question_id", UUID.class)); return true;
        }).list();
    selections.forEach((question, option) -> {
      if (option != null && !question.equals(optionQuestions.get(option))) throw SubmitRequest.invalid("Вариант не принадлежит этому вопросу.");
      normalized.put(question, option);
    });
    if ("completed".equals(attempt.status())) {
      var saved = new HashMap<UUID, UUID>();
      jdbc.sql("SELECT question_id,selected_option_id FROM studymate.attempt_answers WHERE attempt_id=:id")
          .param("id", id).query((r,n) -> {
            saved.put(r.getObject("question_id", UUID.class), r.getObject("selected_option_id", UUID.class)); return true;
          }).list();
      if (!saved.equals(normalized)) throw error(HttpStatus.CONFLICT, "ATTEMPT_ALREADY_SUBMITTED", "Попытка уже завершена. Открой сохранённый результат.");
      return view(attempt);
    }
    int correct = 0;
    for (var key : keys) {
      UUID selected = normalized.get(key.question());
      boolean matches = key.correctOption().equals(selected);
      if (matches) correct++;
      jdbc.sql("""
          INSERT INTO studymate.attempt_answers(attempt_id,quiz_id,question_id,selected_option_id,is_correct)
          VALUES (:attempt,:quiz,:question,:option,:correct)
          """).param("attempt", id).param("quiz", attempt.quizId()).param("question", key.question())
          .param("option", selected, Types.OTHER).param("correct", matches).update();
    }
    BigDecimal score = BigDecimal.valueOf(100L * correct).divide(BigDecimal.valueOf(attempt.questionCount()), 2, RoundingMode.HALF_UP);
    jdbc.sql("""
        UPDATE studymate.attempts SET status='completed',completed_at=greatest(started_at,clock_timestamp()),
          correct_count=:correct,score_percent=:score WHERE id=:id AND owner_id=:owner
        """).param("correct", correct).param("score", score).param("id", id).param("owner", owner).update();
    return view(load(owner, id, false));
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ, timeout = 10)
  public View get(UUID owner, UUID id) { return view(load(owner, id, false)); }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ, timeout = 10)
  public Page list(UUID owner, AttemptQuery query) {
    String filter = " WHERE a.owner_id=:owner AND o.state='stored'";
    var params = new HashMap<String,Object>(); params.put("owner", owner);
    if (query.materialId() != null) { filter += " AND q.material_id=:material"; params.put("material", query.materialId()); }
    if (query.quizId() != null) { filter += " AND a.quiz_id=:quiz"; params.put("quiz", query.quizId()); }
    if (query.status() != null) { filter += " AND a.status=:status"; params.put("status", query.status()); }
    long total = jdbc.sql("SELECT count(*) " + FROM + filter).params(params).query(Long.class).single();
    var rows = jdbc.sql("SELECT " + COLUMNS + FROM + filter + " ORDER BY a.started_at DESC,a.id DESC LIMIT :limit OFFSET :offset")
        .params(params).param("limit", query.pageSize()).param("offset", query.offset()).query((r,n) -> info(r)).list();
    return new Page(rows, new Meta(query.page(), query.pageSize(), total));
  }

  private Info load(UUID owner, UUID id, boolean lock) {
    return jdbc.sql("SELECT " + COLUMNS + ",o.state " + FROM + " WHERE a.id=:id AND a.owner_id=:owner"
        + (lock ? " FOR UPDATE OF o,m,a" : "")).param("id", id).param("owner", owner).query((r,n) -> {
          requireStored(r.getString("state")); return info(r);
        }).optional().orElseThrow(() -> error(HttpStatus.NOT_FOUND, "ATTEMPT_NOT_FOUND", "Попытка не найдена."));
  }
  private View view(Info a) {
    // This query never reads private keys. Review is loaded only for this completed attempt.
    var questions = jdbc.sql("SELECT id,position,text_content FROM studymate.quiz_questions WHERE quiz_id=:quiz ORDER BY position")
        .param("quiz", a.quizId()).query((r,n) -> {
          UUID id = r.getObject("id", UUID.class);
          var options = jdbc.sql("SELECT id,position,text_content FROM studymate.quiz_options WHERE question_id=:id ORDER BY position")
              .param("id", id).query((o,i) -> new Option(o.getObject("id", UUID.class), o.getInt("position"), o.getString("text_content"))).list();
          return new Question(id, r.getInt("position"), r.getString("text_content"), options);
        }).list();
    List<Review> review = null;
    if ("completed".equals(a.status())) {
      review = jdbc.sql("""
          SELECT q.id,aa.selected_option_id,q.correct_option_id,aa.is_correct,q.explanation,q.source_pages::text
          FROM studymate.attempt_answers aa JOIN studymate.quiz_questions q ON q.id=aa.question_id AND q.quiz_id=aa.quiz_id
          WHERE aa.attempt_id=:id ORDER BY q.position
          """).param("id", a.id()).query((r,n) -> new Review(r.getObject("id", UUID.class), r.getObject("selected_option_id", UUID.class),
              r.getObject("correct_option_id", UUID.class), r.getBoolean("is_correct"), r.getString("explanation"),
              Arrays.asList(json.readValue(r.getString("source_pages"), Integer[].class)))).list();
    }
    return new View(a.id(), a.quizId(), a.materialId(), a.quizVersion(), a.status(), a.questionCount(),
        a.startedAt(), a.completedAt(), a.correctCount(), a.scorePercent(), questions, review);
  }
  private static Info info(ResultSet r) throws SQLException {
    var completed = r.getTimestamp("completed_at");
    return new Info(r.getObject("id", UUID.class), r.getObject("quiz_id", UUID.class), r.getObject("material_id", UUID.class),
        r.getLong("quiz_version"), r.getString("status"), r.getInt("question_count"), r.getTimestamp("started_at").toInstant(),
        completed == null ? null : completed.toInstant(), r.getObject("correct_count", Integer.class), r.getBigDecimal("score_percent"));
  }
  private void lockOwner(UUID owner) {
    jdbc.sql("SELECT id FROM studymate.users WHERE id=:owner FOR UPDATE").param("owner", owner).query(UUID.class).single();
  }
  private static void requireStored(String state) {
    if (!"stored".equals(state)) throw error(HttpStatus.CONFLICT, "MATERIAL_NOT_AVAILABLE", "Материал недоступен.");
  }
  private static ApiException error(HttpStatus status, String code, String message) { return new ApiException(status, code, message, Map.of()); }
}
