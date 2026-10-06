package com.studymate;

import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

public abstract class PostgresIntegrationTest {
  @DynamicPropertySource
  static void database(DynamicPropertyRegistry registry) {
    // Worker lifecycle is tested explicitly. Cached HTTP test contexts must not recover each other's fixtures.
    registry.add("studymate.jobs.enabled", () -> "false");
    registry.add("studymate.materials.maintenance-enabled", () -> "false");
    // Rate-limit boundary/concurrency/HTTP tests use their own enabled context (PilotLimitsIT).
    registry.add("studymate.limits.enabled", () -> "false");
    registry.add("spring.datasource.url", () -> required("STUDYMATE_TEST_DATABASE_URL"));
    registry.add("spring.datasource.username", () -> required("STUDYMATE_TEST_DATABASE_USERNAME"));
    registry.add("spring.datasource.password", () -> required("STUDYMATE_TEST_DATABASE_PASSWORD"));
  }

  private static String required(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      throw new IllegalStateException("Set " + name + " to a dedicated PostgreSQL test database");
    }
    return value;
  }
}
