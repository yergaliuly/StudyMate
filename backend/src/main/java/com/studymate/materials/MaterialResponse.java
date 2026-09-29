package com.studymate.materials;

import java.time.Instant;
import java.util.UUID;

record MaterialResponse(UUID id, UUID subjectId, String title, String fileName, String contentType,
    long sizeBytes, String status, String processingStatus, long version, Instant createdAt, Instant updatedAt,
    UUID deletionJobId) {}
