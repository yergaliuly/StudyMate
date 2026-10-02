package com.studymate.attempts;

import com.studymate.common.api.ApiException;
import com.studymate.common.api.ApiResponse;
import com.studymate.identity.CurrentAccount;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
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
class AttemptController {
  private final CurrentAccount accounts;
  private final AttemptRepository attempts;
  AttemptController(CurrentAccount accounts, AttemptRepository attempts) { this.accounts = accounts; this.attempts = attempts; }

  @PostMapping("/api/v1/quizzes/{id}/attempts")
  ResponseEntity<?> start(@PathVariable String id, Authentication auth, HttpServletRequest request) throws IOException {
    UUID owner = accounts.requireUser(auth, request).id(); noQuery(request);
    UUID quiz = id(id);
    var keys = Collections.list(request.getHeaders("Idempotency-Key"));
    if (keys.isEmpty()) throw error("IDEMPOTENCY_KEY_REQUIRED", "Передай Idempotency-Key.");
    if (keys.size() != 1 || !keys.getFirst().matches(SubmitRequest.UUID_PATTERN))
      throw error("INVALID_IDEMPOTENCY_KEY", "Ключ запроса должен быть UUID.");
    if (request.getInputStream().read() != -1) throw error("INVALID_REQUEST", "Этот запрос не принимает тело.");
    return ResponseEntity.status(HttpStatus.CREATED).header("Cache-Control", "no-store")
        .body(new ApiResponse<>(attempts.start(owner, quiz, UUID.fromString(keys.getFirst()))));
  }
  @PostMapping("/api/v1/attempts/{id}/submit")
  ResponseEntity<?> submit(@PathVariable String id, @Valid @RequestBody SubmitRequest body,
      Authentication auth, HttpServletRequest request) {
    UUID owner = accounts.requireUser(auth, request).id(); noQuery(request);
    return ok(attempts.submit(owner, id(id), body.selections()));
  }
  @GetMapping("/api/v1/attempts/{id}")
  ResponseEntity<?> get(@PathVariable String id, Authentication auth, HttpServletRequest request) {
    UUID owner = accounts.requireUser(auth, request).id(); noQuery(request);
    return ok(attempts.get(owner, id(id)));
  }
  @GetMapping("/api/v1/attempts")
  ResponseEntity<?> list(@RequestParam MultiValueMap<String,String> query, Authentication auth, HttpServletRequest request) {
    UUID owner = accounts.requireUser(auth, request).id();
    return ResponseEntity.ok().header("Cache-Control", "no-store").body(attempts.list(owner, AttemptQuery.parse(query)));
  }
  private static ResponseEntity<?> ok(Object value) {
    return ResponseEntity.ok().header("Cache-Control", "no-store").body(new ApiResponse<>(value));
  }
  private static UUID id(String value) {
    if (!value.matches(SubmitRequest.UUID_PATTERN)) throw error("INVALID_ID", "Идентификатор должен быть UUID.");
    return UUID.fromString(value);
  }
  private static void noQuery(HttpServletRequest request) {
    if (request.getQueryString() != null && !request.getQueryString().isEmpty()) throw error("INVALID_QUERY", "Этот запрос не принимает query.");
  }
  private static ApiException error(String code, String message) { return new ApiException(HttpStatus.BAD_REQUEST, code, message, Map.of()); }
}
