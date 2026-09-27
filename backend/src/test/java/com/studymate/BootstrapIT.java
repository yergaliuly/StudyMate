package com.studymate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class BootstrapIT {
  @DynamicPropertySource
  static void database(DynamicPropertyRegistry registry) {
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

  @Value("${local.server.port}") int port;
  @Autowired JdbcTemplate jdbc;
  @Autowired Flyway flyway;
  @Autowired JsonMapper mapper;
  @Autowired ApplicationContext context;

  @Test
  void migrationsCreateSchemaAndAreSafeToRepeat() {
    assertThat(jdbc.queryForObject("SELECT current_setting('server_version_num')::int", Integer.class))
        .isGreaterThanOrEqualTo(170000);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'studymate'",
        Integer.class)).isEqualTo(1);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM public.flyway_schema_history WHERE success AND version = '1'",
        Integer.class)).isEqualTo(1);
    assertThat(jdbc.queryForObject("SHOW TIME ZONE", String.class)).isEqualTo("UTC");
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
  void unsafeRequestsRequireCsrf() throws Exception {
    var response = request("POST", "/api/v1/subjects");
    assertThat(response.statusCode()).isEqualTo(403);
    assertThat(mapper.readTree(response.body()).at("/error/code").asString()).isEqualTo("CSRF_INVALID");
    assertThat(mapper.readTree(response.body()).at("/error/fieldErrors").isEmpty()).isTrue();
  }

  private HttpResponse<String> request(String method, String path) throws Exception {
    try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()) {
      return client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
          .timeout(Duration.ofSeconds(10)).method(method, HttpRequest.BodyPublishers.noBody()).build(),
          HttpResponse.BodyHandlers.ofString());
    }
  }
}
