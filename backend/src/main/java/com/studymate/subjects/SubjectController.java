package com.studymate.subjects;

import com.studymate.common.api.ApiException;
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
