package com.studymate.jobs;

import com.studymate.common.api.ApiException;
import com.studymate.common.api.ApiResponse;
import com.studymate.identity.CurrentAccount;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
class JobController {
  private final CurrentAccount accounts;
  private final JobQueue jobs;
  JobController(CurrentAccount accounts, JobQueue jobs) { this.accounts = accounts; this.jobs = jobs; }

  @GetMapping("/api/v1/jobs/{id}")
  ResponseEntity<ApiResponse<JobResponse>> get(@PathVariable String id, @RequestParam MultiValueMap<String, String> query,
      Authentication authentication, HttpServletRequest request) {
    var owner = accounts.requireUser(authentication, request).id();
    if (!query.isEmpty()) throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_QUERY", "Этот запрос не принимает параметры query.", Map.of());
    if (!id.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) {
      throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_ID", "Идентификатор задания должен быть UUID.", Map.of());
    }
    return ResponseEntity.ok().header("Cache-Control", "no-store")
        .body(new ApiResponse<>(jobs.get(owner, UUID.fromString(id))));
  }
}
