package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.studymate.PostgresIntegrationTest;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.session.jdbc.JdbcIndexedSessionRepository;
import org.springframework.session.Session;
import org.springframework.util.SerializationUtils;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "studymate.registration.enabled=true")
@ActiveProfiles("local")
class AuthIT extends PostgresIntegrationTest {
  @Value("${local.server.port}") int port;
  @Autowired JdbcTemplate jdbc;
  @Autowired JdbcIndexedSessionRepository sessions;

  @Test
  void completeFlowRotatesSessionAndCsrfAndInvalidatesLogoutInPostgres() throws Exception {
    try (var browser = new AuthHttpClient(port); var oldBrowser = new AuthHttpClient(port)) {
      var csrf = browser.csrf();
      String setCookie = csrf.headers().firstValue("Set-Cookie").orElseThrow();
      assertThat(setCookie.contains("HttpOnly")).isTrue();
      assertThat(setCookie.contains("SameSite=Lax")).isTrue();
      assertThat(setCookie.contains("Path=/")).isTrue();
      assertThat(setCookie.contains("Secure") || setCookie.contains("Domain=")).isFalse();
      String email = email();
      String userId = browser.register(email);
      assertThat(browser.error(browser.send("GET", "/auth/me", null, null), 401))
          .isEqualTo("AUTHENTICATION_REQUIRED");
      String beforeLogin = browser.cookie;
      String oldId = browser.sessionId();
      String oldToken = browser.token;
      var user = browser.data(browser.login(" \uFEFF" + email.toUpperCase(java.util.Locale.ROOT) + "\u00A0 "), 200);
      assertThat(user.get("id").asString()).isEqualTo(userId);
      assertThat(user.get("email").asString()).isEqualTo(email);
      assertThat(user.size()).isEqualTo(3);
      assertThat(beforeLogin.equals(browser.cookie)).isFalse();
      assertThat(sessions.findById(oldId)).isNull();
      oldBrowser.cookie = beforeLogin;
      assertThat(oldBrowser.error(oldBrowser.send("GET", "/auth/me", null, null), 401))
          .isEqualTo("AUTHENTICATION_REQUIRED");
      String loggedInId = browser.sessionId();
      Session stored = sessions.findById(loggedInId);
      String primaryId = jdbc.queryForObject("SELECT primary_id FROM studymate.spring_session WHERE session_id = ?",
          String.class, loggedInId);
      SecurityContext context = stored.getAttribute("SPRING_SECURITY_CONTEXT");
      assertThat(context.getAuthentication().getPrincipal()).isEqualTo(userId);
      assertThat(context.getAuthentication().getCredentials()).isNull();
      assertThat(stored.getMaxInactiveInterval()).isEqualTo(Duration.ofMinutes(30));
      byte[] bytes = jdbc.queryForObject("""
          SELECT a.attribute_bytes FROM studymate.spring_session_attributes a
          JOIN studymate.spring_session s ON s.primary_id = a.session_primary_id
          WHERE s.session_id = ? AND a.attribute_name = 'SPRING_SECURITY_CONTEXT'
          """, byte[].class, loggedInId);
      String serialized = new String(bytes, java.nio.charset.StandardCharsets.ISO_8859_1);
      assertThat(serialized.contains(AuthHttpClient.PASSWORD) || serialized.contains("argon2")
          || serialized.contains(email)).isFalse();
      assertThat(browser.error(browser.send("POST", "/auth/logout", null, oldToken), 403)).isEqualTo("CSRF_INVALID");
      assertThat(browser.data(browser.send("GET", "/auth/me", null, null), 200).get("id").asString()).isEqualTo(userId);
      browser.csrf();
      var logout = browser.send("POST", "/auth/logout", null, browser.token);
      assertThat(logout.statusCode()).isEqualTo(204);
      assertThat(logout.body()).isEmpty();
      assertThat(logout.headers().firstValue("Set-Cookie").orElseThrow().contains("Max-Age=0")).isTrue();
      assertThat(browser.cookie).isNull();
      assertThat(sessions.findById(loggedInId)).isNull();
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.spring_session_attributes WHERE session_primary_id = ?",
          Long.class, primaryId)).isZero();
      assertThat(browser.error(browser.send("GET", "/auth/me", null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      assertThat(browser.error(browser.send("POST", "/auth/logout", null, browser.token), 403)).isEqualTo("CSRF_INVALID");
      browser.csrf();
      assertThat(browser.send("POST", "/auth/logout", null, browser.token).statusCode()).isEqualTo(204);
    }
  }

  @Test
  void wrongCredentialsAreIndistinguishableAndPasswordIsNeverTrimmed() throws Exception {
    try (var browser = new AuthHttpClient(port)) {
      String email = email();
      browser.register(email);
      var known = browser.send("POST", "/auth/login", Map.of("email", email, "password", "wrong"), browser.token);
      var unknown = browser.send("POST", "/auth/login", Map.of("email", email(), "password", "wrong"), browser.token);
      assertThat(browser.error(known, 401)).isEqualTo("INVALID_CREDENTIALS");
      assertThat(browser.error(unknown, 401)).isEqualTo("INVALID_CREDENTIALS");
      assertThat(known.body()).isEqualTo(unknown.body());
      assertThat(browser.error(browser.send("POST", "/auth/login",
          Map.of("email", email, "password", AuthHttpClient.PASSWORD.trim()), browser.token), 401))
          .isEqualTo("INVALID_CREDENTIALS");
      assertThat(browser.send("GET", "/auth/me", null, null).statusCode()).isEqualTo(401);
      browser.data(browser.login(email), 200);
    }
  }

  @Test
  void missingInvalidAndOtherSessionsCsrfCannotAuthenticateOrLogout() throws Exception {
    try (var browser = new AuthHttpClient(port); var other = new AuthHttpClient(port)) {
      String email = email();
      browser.register(email);
      other.csrf();
      for (String token : new String[]{null, "invalid", other.token}) {
        for (String path : new String[]{"/auth/login", "/auth/logout", "/auth/register"}) {
          assertThat(browser.error(browser.send("POST", path,
              Map.of("email", email, "password", AuthHttpClient.PASSWORD), token), 403)).isEqualTo("CSRF_INVALID");
        }
      }
      browser.data(browser.login(email), 200);
      assertThat(browser.send("GET", "/auth/logout", null, null).statusCode()).isEqualTo(403);
      assertThat(browser.send("GET", "/auth/me", null, null).statusCode()).isEqualTo(200);
    }
  }

  @Test
  void independentAccountsAndAccountSwitchKeepOnlyTheCurrentPrincipal() throws Exception {
    try (var a = new AuthHttpClient(port); var b = new AuthHttpClient(port); var stale = new AuthHttpClient(port)) {
      String emailA = email();
      String emailB = email();
      String idA = a.register(emailA);
      String idB = b.register(emailB);
      a.data(a.login(emailA), 200);
      b.data(b.login(emailB), 200);
      assertThat(a.data(a.send("GET", "/auth/me", null, null), 200).get("id").asString()).isEqualTo(idA);
      assertThat(b.data(b.send("GET", "/auth/me", null, null), 200).get("id").asString()).isEqualTo(idB);
      stale.cookie = a.cookie;
      a.csrf();
      assertThat(a.data(a.login(emailB), 200).get("id").asString()).isEqualTo(idB);
      assertThat(stale.send("GET", "/auth/me", null, null).statusCode()).isEqualTo(401);
      a.csrf();
      assertThat(a.send("POST", "/auth/logout", null, a.token).statusCode()).isEqualTo(204);
      assertThat(b.data(b.send("GET", "/auth/me", null, null), 200).get("id").asString()).isEqualTo(idB);
    }
  }

  @Test
  void idleAndAbsoluteExpiryDenyAccessAndAllowFreshAnonymousCsrf() throws Exception {
    for (boolean absolute : new boolean[]{false, true}) {
      try (var browser = new AuthHttpClient(port)) {
        String email = email();
        browser.register(email);
        browser.data(browser.login(email), 200);
        browser.csrf();
        String sessionId = browser.sessionId();
        if (absolute) {
          jdbc.update("""
              UPDATE studymate.spring_session_attributes SET attribute_bytes = ?
              WHERE session_primary_id = (SELECT primary_id FROM studymate.spring_session WHERE session_id = ?)
              AND attribute_name = ?
              """, SerializationUtils.serialize(System.currentTimeMillis() - Duration.ofHours(12).toMillis()),
              sessionId, SessionLifetimeFilter.AUTHENTICATED_AT);
        } else {
          jdbc.update("UPDATE studymate.spring_session SET last_access_time = ?, expiry_time = ? WHERE session_id = ?",
              System.currentTimeMillis() - Duration.ofMinutes(31).toMillis(), System.currentTimeMillis() - 1000, sessionId);
        }
        assertThat(browser.error(browser.send("POST", "/auth/logout", null, browser.token), 403)).isEqualTo("CSRF_INVALID");
        assertThat(browser.send("GET", "/auth/me", null, null).statusCode()).isEqualTo(401);
        browser.csrf();
        browser.data(browser.login(email), 200);
      }
    }
  }

  @Test
  void removedAccountInvalidatesItsSessionInsteadOfReturningStaleProfile() throws Exception {
    try (var browser = new AuthHttpClient(port)) {
      String email = email();
      String id = browser.register(email);
      browser.data(browser.login(email), 200);
      String sessionId = browser.sessionId();
      jdbc.update("DELETE FROM studymate.users WHERE id = ?", UUID.fromString(id));
      assertThat(browser.error(browser.send("GET", "/auth/me", null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      assertThat(sessions.findById(sessionId)).isNull();
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"{}", "null", "[]", "{\"email\":\"bad\",\"password\":\"x\"}",
      "{\"email\":\"test@example.com\",\"password\":\"\"}",
      "{\"email\":\"test@example.com\",\"password\":null}",
      "{\"email\":\"test@example.com\",\"password\":123}",
      "{\"email\":\"test@example.com\",\"password\":false}",
      "{\"email\":\"test@example.com\",\"password\":\"x\",\"id\":\"spoofed\"}"})
  void loginRejectsInvalidJsonValues(String body) throws Exception {
    try (var browser = new AuthHttpClient(port)) {
      browser.csrf();
      assertThat(browser.error(browser.send("POST", "/auth/login", body, browser.token), 422)).isEqualTo("VALIDATION_FAILED");
    }
  }

  private static String email() { return "auth-" + UUID.randomUUID() + "@example.com"; }
}
