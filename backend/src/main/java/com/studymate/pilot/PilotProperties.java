package com.studymate.pilot;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("studymate.limits")
public record PilotProperties(
    @DefaultValue("true") boolean enabled,
    @DefaultValue("120") @Min(1) @Max(10000) int csrfPerMinute,
    @DefaultValue("60") @Min(1) @Max(10000) int loginPerMinute,
    @DefaultValue("20") @Min(1) @Max(10000) int registrationsPerHour,
    @DefaultValue("10") @Min(1) @Max(1000) int loginPerEmailQuarterHour,
    @DefaultValue("300") @Min(1) @Max(10000) int accountRequestsPerMinute,
    @DefaultValue("10") @Min(1) @Max(1000) int aiPerAccountDay,
    @DefaultValue("50") @Min(1) @Max(10000) int aiTotalPerDay) {}
