package com.studymate.jobs;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("studymate.jobs")
public record JobProperties(
    @DefaultValue("1000") @Min(100) @Max(60000) int pollIntervalMs,
    @DefaultValue("5000") @Min(100) @Max(10000) int heartbeatIntervalMs,
    @DefaultValue("30") @Min(1) @Max(300) int leaseSeconds,
    @DefaultValue("120") @Min(1) @Max(3600) int executionTimeoutSeconds,
    @DefaultValue("3") @Min(1) @Max(10) int maxAttempts,
    @DefaultValue("2") @Min(1) @Max(3600) int retryDelaySeconds,
    @DefaultValue("60") @Min(1) @Max(3600) int maxRetryDelaySeconds) {
  @AssertTrue(message = "Job heartbeat must be at most one third of the lease; timeout must cover the lease.")
  public boolean isLeaseTimingValid() {
    return heartbeatIntervalMs * 3 <= leaseSeconds * 1000 && executionTimeoutSeconds >= leaseSeconds;
  }

  @AssertTrue(message = "Job maximum retry delay must be at least the initial delay.")
  public boolean isRetryTimingValid() { return maxRetryDelaySeconds >= retryDelaySeconds; }
}
