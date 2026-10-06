package com.studymate.pilot;

import com.studymate.common.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/** Shared PostgreSQL windows; never derive identity from untrusted forwarding headers. */
@Service
public class PilotLimits {
  private static final Logger log = LoggerFactory.getLogger(PilotLimits.class);
  private final JdbcClient jdbc;
  private final PilotProperties settings;
  private final TransactionTemplate independent;

  public PilotLimits(JdbcClient jdbc, PilotProperties settings, PlatformTransactionManager transactions) {
    this.jdbc = jdbc; this.settings = settings;
    independent = new TransactionTemplate(transactions);
    independent.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    independent.setTimeout(5);
  }

  public void authRequest(String action) {
    if (!settings.enabled()) return;
    switch (action) {
      case "csrf" -> request("csrf", "global", settings.csrfPerMinute(), 60);
      case "login" -> request("login", "global", settings.loginPerMinute(), 60);
      case "register" -> request("register", "global", settings.registrationsPerHour(), 3600);
      default -> throw new IllegalArgumentException("Unknown auth action");
    }
  }

  public void loginEmail(String normalizedEmail) {
    if (settings.enabled()) request("login-email", digest(normalizedEmail), settings.loginPerEmailQuarterHour(), 900);
  }

  public void accountRequest(UUID owner) {
    if (settings.enabled()) request("account-api", owner.toString(), settings.accountRequestsPerMinute(), 60);
  }

  // Commit attempts even when credentials/CSRF are invalid. Throw only AFTER commit.
  private void request(String bucket, String subject, int limit, int seconds) {
    int retry = independent.execute(status -> consume(bucket, subject, limit, seconds));
    if (retry > 0) throw limited(retry);
  }

  /** Called AFTER idempotency lookup, inside the same transaction that creates a new AI job. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void aiGeneration(UUID owner) {
    if (!settings.enabled()) return;
    int retry = consume("ai-global", "global", settings.aiTotalPerDay(), 86400);
    if (retry == 0) retry = consume("ai-account", owner.toString(), settings.aiPerAccountDay(), 86400);
    // On rejection both counters roll back with job creation; accepted/failed jobs are not refunded.
    if (retry > 0) throw limited(retry);
  }

  private int consume(String bucket, String subject, int limit, int seconds) {
    var accepted = jdbc.sql("""
        INSERT INTO studymate.request_limits(bucket,subject,used,expires_at)
        VALUES (:bucket,:subject,1,statement_timestamp()+make_interval(secs => :seconds))
        ON CONFLICT (bucket,subject) DO UPDATE SET
          used=CASE WHEN request_limits.expires_at<=statement_timestamp() THEN 1 ELSE request_limits.used+1 END,
          expires_at=CASE WHEN request_limits.expires_at<=statement_timestamp()
            THEN statement_timestamp()+make_interval(secs => :seconds) ELSE request_limits.expires_at END
        WHERE request_limits.expires_at<=statement_timestamp() OR request_limits.used<:maximum
        RETURNING used
        """).param("bucket", bucket).param("subject", subject).param("seconds", seconds).param("maximum", limit)
        .query(Integer.class).optional();
    if (accepted.isPresent()) return 0;
    return jdbc.sql("""
        SELECT GREATEST(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::int
        FROM studymate.request_limits WHERE bucket=:bucket AND subject=:subject
        """).param("bucket", bucket).param("subject", subject).query(Integer.class).optional().orElse(1);
  }

  @Scheduled(initialDelay=60000, fixedDelay=60000)
  void cleanup() {
    if (!settings.enabled()) return;
    try {
      jdbc.sql("""
          DELETE FROM studymate.request_limits WHERE (bucket,subject) IN (
            SELECT bucket,subject FROM studymate.request_limits
            WHERE expires_at<clock_timestamp()-interval '1 hour' ORDER BY expires_at LIMIT 1000
            FOR UPDATE SKIP LOCKED)
          """).update();
    } catch (RuntimeException failure) { log.warn("Rate limit cleanup incomplete (type={})", failure.getClass().getSimpleName()); }
  }

  private static ApiException limited(int seconds) {
    return new ApiException(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED",
        "Слишком много запросов. Повтори позже.", Map.of(), seconds);
  }

  private static String digest(String email) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(email.getBytes(StandardCharsets.UTF_8))); }
    catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
  }
}
