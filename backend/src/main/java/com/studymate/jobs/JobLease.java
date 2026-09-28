package com.studymate.jobs;

import java.util.UUID;
import tools.jackson.databind.JsonNode;

/** Internal execution data, not an API DTO. The token fences every renewal/completion. */
public record JobLease(UUID id, UUID ownerId, String kind, JsonNode payload, UUID token,
    int attemptCount, RetryPolicy retryPolicy, int leaseSeconds) {
  @Override public String toString() { return "JobLease[redacted]"; }
}
