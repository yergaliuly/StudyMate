package com.studymate.quizzes;

import com.studymate.ai.QuizProvider;
import com.studymate.ai.SummaryProvider;
import com.studymate.common.api.ApiException;
import com.studymate.common.api.ApiResponse;
import com.studymate.identity.CurrentAccount;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

@RestController
class QuizController {
  private final CurrentAccount accounts;
  private final QuizRepository quizzes;
  private final QuizProvider provider;
  private final SummaryProvider notes;
  QuizController(CurrentAccount accounts, QuizRepository quizzes, QuizProvider provider, SummaryProvider notes) {
    this.accounts = accounts; this.quizzes = quizzes; this.provider = provider; this.notes = notes;
  }
  @PostMapping("/api/v1/materials/{id}/quizzes")
  ResponseEntity<?> generate(@PathVariable String id, Authentication auth, HttpServletRequest request) throws IOException {
    UUID owner = accounts.requireUser(auth, request).id(); noQuery(request);
    UUID material = id(id);
    var keys = Collections.list(request.getHeaders("Idempotency-Key"));
    if (keys.isEmpty()) throw error("IDEMPOTENCY_KEY_REQUIRED", "Передай Idempotency-Key.");
    if (keys.size() != 1 || !isUuid(keys.getFirst())) throw error("INVALID_IDEMPOTENCY_KEY", "Ключ запроса должен быть UUID.");
    if (request.getInputStream().read() != -1) throw error("INVALID_REQUEST", "Этот запрос не принимает тело.");
    if (!provider.available() || !notes.available())
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "AI_UNAVAILABLE", "Генерация пока недоступна.", Map.of());
    return ResponseEntity.accepted().header("Cache-Control", "no-store")
        .body(new ApiResponse<>(quizzes.start(owner, material, UUID.fromString(keys.getFirst()))));
  }
  @GetMapping("/api/v1/materials/{id}/quizzes")
  ResponseEntity<?> list(@PathVariable String id, @RequestParam MultiValueMap<String,String> query,
      Authentication auth, HttpServletRequest request) {
    UUID owner = accounts.requireUser(auth, request).id();
    return ResponseEntity.ok().header("Cache-Control", "no-store").body(quizzes.list(owner, id(id), QuizQuery.parse(query)));
  }
  @GetMapping("/api/v1/quizzes/{id}")
  ResponseEntity<?> get(@PathVariable String id, Authentication auth, HttpServletRequest request) {
    UUID owner = accounts.requireUser(auth, request).id(); noQuery(request);
    return ResponseEntity.ok().header("Cache-Control", "no-store").body(new ApiResponse<>(quizzes.get(owner, id(id))));
  }
  private static boolean isUuid(String value) { return value.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"); }
  private static UUID id(String value) {
    if (!isUuid(value)) throw error("INVALID_ID", "Идентификатор должен быть UUID.");
    return UUID.fromString(value);
  }
  private static void noQuery(HttpServletRequest request) {
    if (request.getQueryString() != null && !request.getQueryString().isEmpty()) throw error("INVALID_QUERY", "Этот запрос не принимает query.");
  }
  private static ApiException error(String code, String message) { return new ApiException(HttpStatus.BAD_REQUEST, code, message, Map.of()); }
}
