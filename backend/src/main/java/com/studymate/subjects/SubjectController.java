package com.studymate.subjects;

import com.studymate.common.api.ApiException;
import com.studymate.common.api.ApiResponse;
import com.studymate.identity.CurrentAccount;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.net.URI;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
class SubjectController {
  private final CurrentAccount accounts;
  private final SubjectService subjects;
  SubjectController(CurrentAccount accounts, SubjectService subjects) { this.accounts = accounts; this.subjects = subjects; }

  @GetMapping("/api/v1/subjects")
  ResponseEntity<SubjectPage> list(@RequestParam MultiValueMap<String, String> query,
      Authentication authentication, HttpServletRequest request) {
    var owner = accounts.requireUser(authentication, request).id();
    return ResponseEntity.ok().header("Cache-Control", "no-store").body(subjects.list(owner, SubjectQuery.parse(query)));
  }

  @PostMapping(path = "/api/v1/subjects", consumes = MediaType.APPLICATION_JSON_VALUE)
  ResponseEntity<String> create(@Valid @RequestBody SubjectCreateRequest input,
      Authentication authentication, HttpServletRequest request) {
    var owner = accounts.requireUser(authentication, request).id();
    var result = subjects.create(owner, requestKey(request), input);
    return ResponseEntity.created(URI.create(result.location())).contentType(MediaType.APPLICATION_JSON)
        .header("Cache-Control", "no-store").body(result.body());
  }

  @GetMapping("/api/v1/subjects/{id}")
  ResponseEntity<ApiResponse<SubjectResponse>> get(@PathVariable String id,
      @RequestParam MultiValueMap<String, String> query, Authentication authentication, HttpServletRequest request) {
    var owner = accounts.requireUser(authentication, request).id();
    noQuery(query);
    return ResponseEntity.ok().header("Cache-Control", "no-store")
        .body(new ApiResponse<>(subjects.get(owner, subjectId(id))));
  }

  @PatchMapping(path = "/api/v1/subjects/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
  ResponseEntity<ApiResponse<SubjectResponse>> update(@PathVariable String id,
      @Valid @RequestBody SubjectPatchRequest input, @RequestParam MultiValueMap<String, String> query,
      Authentication authentication, HttpServletRequest request) {
    var owner = accounts.requireUser(authentication, request).id();
    noQuery(query);
    return ResponseEntity.ok().header("Cache-Control", "no-store")
        .body(new ApiResponse<>(subjects.update(owner, subjectId(id), input)));
  }

  @DeleteMapping("/api/v1/subjects/{id}")
  ResponseEntity<Void> delete(@PathVariable String id, @RequestParam MultiValueMap<String, String> query,
      Authentication authentication, HttpServletRequest request) {
    var owner = accounts.requireUser(authentication, request).id();
    noQuery(query);
    subjects.delete(owner, subjectId(id));
    return ResponseEntity.noContent().header("Cache-Control", "no-store").build();
  }

  private static UUID subjectId(String value) {
    if (!value.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) {
      throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_ID", "Идентификатор предмета должен быть UUID.", Map.of());
    }
    return UUID.fromString(value);
  }

  private static void noQuery(MultiValueMap<String, String> query) {
    if (!query.isEmpty()) throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_QUERY",
        "Этот запрос не принимает параметры query.", Map.of());
  }

  private static UUID requestKey(HttpServletRequest request) {
    var values = Collections.list(request.getHeaders("Idempotency-Key"));
    if (values.isEmpty()) throw new ApiException(HttpStatus.BAD_REQUEST, "IDEMPOTENCY_KEY_REQUIRED",
        "Передай ключ запроса Idempotency-Key.", Map.of());
    if (values.size() != 1 || !values.getFirst().matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) {
      throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_IDEMPOTENCY_KEY", "Ключ запроса должен быть UUID.", Map.of());
    }
    return UUID.fromString(values.getFirst());
  }
}
