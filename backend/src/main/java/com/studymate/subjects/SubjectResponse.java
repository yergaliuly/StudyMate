package com.studymate.subjects;

import java.time.Instant;
import java.util.UUID;

record SubjectResponse(UUID id, String title, String description, String icon, String tone,
    int lectureCount, Integer progressPercent, Instant createdAt, long version) {}
