package com.studymate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "studymate.registration.enabled=false")
@AutoConfigureMockMvc
class BootstrapIT extends PostgresIntegrationTest {

  @Value("${local.server.port}") int port;
  @Autowired JdbcTemplate jdbc;
  @Autowired Flyway flyway;
  @Autowired JsonMapper mapper;
  @Autowired ApplicationContext context;
  @Autowired MockMvc mvc;

  @Test
  void migrationsCreateSchemaAndAreSafeToRepeat() {
    assertThat(jdbc.queryForObject("SELECT current_setting('server_version_num')::int", Integer.class))
        .isGreaterThanOrEqualTo(170000);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'studymate'",
        Integer.class)).isEqualTo(1);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM public.flyway_schema_history WHERE success AND version = '1'",
        Integer.class)).isEqualTo(1);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM public.flyway_schema_history WHERE success AND version = '2'",
        Integer.class)).isEqualTo(1);
    assertThat(jdbc.queryForObject("SHOW TIME ZONE", String.class)).isEqualTo("UTC");
    assertThat(jdbc.queryForObject("SELECT count(*) FROM public.flyway_schema_history WHERE success AND version = '3'",
        Integer.class)).isEqualTo(1);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM public.flyway_schema_history WHERE success AND version = '4'",
        Integer.class)).isEqualTo(1);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM public.flyway_schema_history WHERE success AND version = '5'",
        Integer.class)).isEqualTo(1);
    flyway.validate();
    assertThat(flyway.migrate().migrationsExecuted).isZero();
    assertThatThrownBy(flyway::clean).isInstanceOf(FlywayException.class)
        .hasMessageContaining("cleanDisabled");
  }

  @Test
  void realHttpHealthChecksPostgresWithoutExposingDetails() throws Exception {
    var response = request("GET", "/actuator/health");
    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(mapper.readTree(response.body())).isEqualTo(mapper.readTree("{\"status\":\"UP\"}"));
    assertThat(context.getBeansOfType(UserDetailsService.class)).isEmpty();
  }

  @Test
  void applicationAndManagementRoutesAreClosedWithoutHtmlLogin() throws Exception {
    for (String path : new String[]{"/api/v1/auth/me", "/api/v1/subjects", "/actuator/env", "/login"}) {
      var response = request("GET", path);
      assertThat(response.statusCode()).isEqualTo(401);
      assertThat(mapper.readTree(response.body()).at("/error/code").asString())
          .isEqualTo("AUTHENTICATION_REQUIRED");
      assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
      assertThat(response.headers().firstValue("Location")).isEmpty();
      assertThat(response.headers().firstValue("WWW-Authenticate")).isEmpty();
    }
  }

  @Test
  void defaultProfileRequiresSecureHttpOnlyHostCookie() throws Exception {
    var response = request("GET", "/api/v1/auth/csrf");
    assertThat(response.statusCode()).isEqualTo(200);
    String cookie = response.headers().firstValue("Set-Cookie").orElseThrow();
    assertThat(cookie.startsWith("STUDYMATE_SESSION=")).isTrue();
    assertThat(cookie.contains("Secure") && cookie.contains("HttpOnly")
        && cookie.contains("SameSite=Lax") && cookie.contains("Path=/")).isTrue();
    assertThat(cookie.contains("Domain=")).isFalse();
  }

  @Test
  void unsafeRequestsRequireCsrf() throws Exception {
    var response = request("POST", "/api/v1/subjects");
    assertThat(response.statusCode()).isEqualTo(403);
    assertThat(mapper.readTree(response.body()).at("/error/code").asString()).isEqualTo("CSRF_INVALID");
    assertThat(mapper.readTree(response.body()).at("/error/fieldErrors").isEmpty()).isTrue();
    var registration = request("POST", "/api/v1/auth/register");
    assertThat(registration.statusCode()).isEqualTo(403);
    assertThat(mapper.readTree(registration.body()).at("/error/code").asString()).isEqualTo("CSRF_INVALID");
  }

  @Test
  void disabledRegistrationRejectsEvenValidCsrf() throws Exception {
    long countBefore = jdbc.queryForObject("SELECT count(*) FROM studymate.users", Long.class);
    mvc.perform(post("/api/v1/auth/register").with(csrf().asHeader())
            .contentType(MediaType.APPLICATION_JSON).content("""
                {"email":"closed@example.com","password":"Example-only password!","displayName":"Test"}
                """))
        .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("REGISTRATION_CLOSED"))
        .andExpect(jsonPath("$.error.fieldErrors").isEmpty());
    assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.users", Long.class)).isEqualTo(countBefore);
  }

  private HttpResponse<String> request(String method, String path) throws Exception {
    try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()) {
      return client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
          .timeout(Duration.ofSeconds(10)).method(method, HttpRequest.BodyPublishers.noBody()).build(),
          HttpResponse.BodyHandlers.ofString());
    }
  }
}
