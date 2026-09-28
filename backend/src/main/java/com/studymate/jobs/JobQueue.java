package com.studymate.jobs;

import com.studymate.common.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Backend-only enqueue/cancel boundary. Joins the caller's domain transaction. */
@Service
public class JobQueue {
  private final JobRepository jobs;
  private final JobProperties settings;
  private final JsonMapper mapper;
  JobQueue(JobRepository jobs, JobProperties settings, JsonMapper mapper) {
    this.jobs = jobs; this.settings = settings; this.mapper = mapper;
  }

  @Transactional(timeout = 10)
  public UUID enqueue(UUID owner, String kind, UUID operationKey, JsonNode payload, RetryPolicy policy) {
    Objects.requireNonNull(owner); Objects.requireNonNull(operationKey); Objects.requireNonNull(policy);
    if (kind == null || !kind.matches("[a-z][a-z0-9_.-]{0,79}") || payload == null || !payload.isObject()) {
      throw new IllegalArgumentException("Invalid internal job request");
    }
    String json = mapper.writeValueAsString(payload);
    if (json.getBytes(StandardCharsets.UTF_8).length > 16384) {
      throw new IllegalArgumentException("Job payload exceeds 16 KiB; store references, not documents");
    }
    var inserted = jobs.insert(owner, kind, operationKey, json, policy, settings);
    if (inserted.isPresent()) return inserted.get();
    // Separate statement sees the winning insert after a concurrent ON CONFLICT wait.
    var existing = jobs.existing(owner, kind, operationKey, json, policy);
    if (!existing.matches()) throw new ApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_REUSED",
        "Этот ключ уже использован для другой операции.", Map.of());
    return existing.id();
  }

  @Transactional(timeout = 10)
  public boolean cancel(UUID owner, UUID id) { return jobs.cancel(owner, id); }

  JobResponse get(UUID owner, UUID id) {
    return jobs.find(owner, id).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,
        "JOB_NOT_FOUND", "Задание не найдено.", Map.of()));
  }
}
