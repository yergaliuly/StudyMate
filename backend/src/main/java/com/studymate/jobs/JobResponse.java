package com.studymate.jobs;

import java.time.Instant;
import java.util.UUID;

record JobResponse(UUID id, String type, String status, int attemptCount, int maxAttempts,
    Instant createdAt, Instant updatedAt, Instant nextAttemptAt, Instant finishedAt,
    UUID resultId, Error error) {
  record Error(String code, String message) {}
}
