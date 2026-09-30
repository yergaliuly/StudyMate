package com.studymate.summaries;

import com.studymate.ai.SummaryProvider;
import com.studymate.common.api.ApiException;
import com.studymate.common.api.ApiResponse;
import com.studymate.common.validation.TextInput;
import com.studymate.common.validation.WellFormedUnicode;
import com.studymate.identity.CurrentAccount;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.io.IOException;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
class SummaryController {
  private final CurrentAccount accounts;
  private final SummaryRepository summaries;
  private final SummaryProvider provider;
  SummaryController(CurrentAccount accounts, SummaryRepository summaries, SummaryProvider provider) {
    this.accounts = accounts; this.summaries = summaries; this.provider = provider;
  }

  @PostMapping("/api/v1/materials/{id}/summary")
  ResponseEntity<?> generate(@PathVariable String id, Authentication auth, HttpServletRequest request) throws IOException {
    UUID owner = accounts.requireUser(auth, request).id();
    noQuery(request);
    UUID material = id(id), key = key(request);
    if (request.getInputStream().read() != -1) throw error(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Этот запрос не принимает тело.");
    if (!provider.available()) throw error(HttpStatus.SERVICE_UNAVAILABLE, "AI_UNAVAILABLE", "Генерация пока недоступна.");
    return ResponseEntity.accepted().header("Cache-Control", "no-store")
        .body(new ApiResponse<>(summaries.start(owner, material, key)));
  }

  @GetMapping("/api/v1/materials/{id}/summary")
  ResponseEntity<?> get(@PathVariable String id, Authentication auth, HttpServletRequest request) {
    UUID owner = accounts.requireUser(auth, request).id(); noQuery(request);
    return ResponseEntity.ok().header("Cache-Control", "no-store")
        .body(new ApiResponse<>(summaries.get(owner, id(id))));
  }

  record EditRequest(@NotNull @Min(1) @Max(9_007_199_254_740_991L) Long version,
      @NotNull @Size(min=1,max=100000) @WellFormedUnicode String content) {}

  @PatchMapping(path="/api/v1/materials/{id}/summary", consumes=MediaType.APPLICATION_JSON_VALUE)
  ResponseEntity<?> edit(@PathVariable String id, @Valid @RequestBody EditRequest input,
      Authentication auth, HttpServletRequest request) {
    UUID owner = accounts.requireUser(auth, request).id(); noQuery(request);
    String content = TextInput.trim(input.content());
    if (content == null || content.isBlank() || content.chars().anyMatch(c -> c == 0 || (c < 32 && c != 9 && c != 10 && c != 13)))
      throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "VALIDATION_FAILED", "Проверь конспект.", Map.of("content", "Недопустимое значение."));
    return ResponseEntity.ok().header("Cache-Control", "no-store")
        .body(new ApiResponse<>(summaries.edit(owner, id(id), input.version(), content)));
  }

  private static UUID id(String value) {
    if (!value.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"))
      throw error(HttpStatus.BAD_REQUEST, "INVALID_ID", "Идентификатор должен быть UUID.");
    return UUID.fromString(value);
  }
  private static UUID key(HttpServletRequest request) {
    var values = Collections.list(request.getHeaders("Idempotency-Key"));
    if (values.isEmpty()) throw error(HttpStatus.BAD_REQUEST, "IDEMPOTENCY_KEY_REQUIRED", "Передай Idempotency-Key.");
    if (values.size() != 1 || !values.getFirst().matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"))
      throw error(HttpStatus.BAD_REQUEST, "INVALID_IDEMPOTENCY_KEY", "Ключ запроса должен быть UUID.");
    return UUID.fromString(values.getFirst());
  }
  private static void noQuery(HttpServletRequest request) {
    if (request.getQueryString() != null && !request.getQueryString().isEmpty())
      throw error(HttpStatus.BAD_REQUEST, "INVALID_QUERY", "Этот запрос не принимает query.");
  }
  private static ApiException error(HttpStatus status, String code, String message) {
    return new ApiException(status, code, message, Map.of());
  }
}
