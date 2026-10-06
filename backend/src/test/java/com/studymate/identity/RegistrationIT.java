package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static com.studymate.identity.SessionCsrf.bootstrap;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.studymate.PostgresIntegrationTest;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "studymate.registration.enabled=true")
@AutoConfigureMockMvc
class RegistrationIT extends PostgresIntegrationTest {
  private static final String PASSWORD = "  Example-only пароль!  ";
  @Autowired MockMvc mvc;
  @Autowired JdbcTemplate jdbc;
  @Autowired JsonMapper mapper;
  @Autowired PasswordEncoder passwords;

  @Test
  void createsAccountWithHashAndReturnsOnlyPublicFieldsWithoutLoggingIn() throws Exception {
    String email = uniqueEmail();
    var result = register(" \u00a0" + email.toUpperCase(Locale.ROOT) + " ", " Айдана ")
        .andExpect(status().isCreated())
        .andExpect(header().string("Cache-Control", "no-store"))
        .andExpect(jsonPath("$.data.email").value(email))
        .andExpect(jsonPath("$.data.displayName").value("Айдана"))
        .andExpect(jsonPath("$.data.length()").value(3)).andReturn();
    String body = result.getResponse().getContentAsString(StandardCharsets.UTF_8);
    UUID id = UUID.fromString(mapper.readTree(body).at("/data/id").asString());
    var saved = jdbc.queryForMap("SELECT * FROM studymate.users WHERE id = ?", id);
    String hash = (String) saved.get("password_hash");
    assertThat(hash).startsWith("{argon2id}$argon2id$").isNotEqualTo(PASSWORD);
    assertThat(passwords.matches(PASSWORD, hash)).isTrue();
    assertThat(passwords.matches(PASSWORD.trim(), hash)).isFalse();
    assertThat(saved.get("normalized_email")).isEqualTo(email);
    assertThat(saved.get("display_name")).isEqualTo("Айдана");
    assertThat(jdbc.queryForObject("SELECT created_at FROM studymate.users WHERE id = ?",
        OffsetDateTime.class, id)).isNotNull();
    assertThat(body).doesNotContain(PASSWORD, hash, "password", "createdAt", "session");
    assertThat(result.getRequest().getSession().getAttribute("SPRING_SECURITY_CONTEXT")).isNull();
    assertThat(result.getResponse().getHeaders("Set-Cookie")).isEmpty();
  }

  @Test
  void normalizedDuplicateReturns409WithoutOverwritingExistingAccount() throws Exception {
    String email = uniqueEmail();
    register(email, "Original").andExpect(status().isCreated());
    Map<String, Object> before = jdbc.queryForMap("SELECT * FROM studymate.users WHERE normalized_email = ?", email);
    register(" " + email.toUpperCase(Locale.ROOT) + "\uFEFF", "Replacement")
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.error.code").value("EMAIL_ALREADY_EXISTS"))
        .andExpect(jsonPath("$.error.fieldErrors.email").isString())
        .andExpect(header().string("Cache-Control", "no-store"));
    assertThat(jdbc.queryForMap("SELECT * FROM studymate.users WHERE normalized_email = ?", email))
        .isEqualTo(before);
    assertThat(count(email)).isEqualTo(1);
  }

  @Test
  void simultaneousRequestsCreateExactlyOneAccount() throws Exception {
    String email = uniqueEmail();
    var start = new CyclicBarrier(2);
    try (var executor = Executors.newFixedThreadPool(2)) {
      var first = executor.submit(() -> {
        start.await(5, TimeUnit.SECONDS);
        return register(email, "First").andReturn().getResponse();
      });
      var second = executor.submit(() -> {
        start.await(5, TimeUnit.SECONDS);
        return register(email.toUpperCase(Locale.ROOT), "Second").andReturn().getResponse();
      });
      var responses = List.of(first.get(15, TimeUnit.SECONDS), second.get(15, TimeUnit.SECONDS));
      assertThat(responses).extracting(response -> response.getStatus()).containsExactlyInAnyOrder(201, 409);
      var conflict = responses.stream().filter(response -> response.getStatus() == 409).findFirst().orElseThrow();
      assertThat(mapper.readTree(conflict.getContentAsString(StandardCharsets.UTF_8)).at("/error/code").asString())
          .isEqualTo("EMAIL_ALREADY_EXISTS");
      assertThat(count(email)).isEqualTo(1);
    }
  }

  @Test
  void plusAliasesAndDotsAreNotCollapsedAndEqualPasswordsUseDifferentSalts() throws Exception {
    String email = uniqueEmail();
    String alias = email.replace("@", ".study+notes@");
    register(email, "One").andExpect(status().isCreated());
    register(alias, "Two").andExpect(status().isCreated());
    assertThat(count(email)).isEqualTo(1);
    assertThat(count(alias)).isEqualTo(1);
    var hashes = jdbc.queryForList("SELECT password_hash FROM studymate.users WHERE normalized_email IN (?, ?)",
        String.class, email, alias);
    assertThat(hashes).hasSize(2).doesNotHaveDuplicates();
  }

  @Test
  void rejectedValidationAndCsrfDoNotCreateRows() throws Exception {
    String email = uniqueEmail();
    String body = mapper.writeValueAsString(Map.of("email", email, "password", PASSWORD, "displayName", "Test"));
    mvc.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("CSRF_INVALID"));
    register(email, " ").andExpect(status().is(422))
        .andExpect(jsonPath("$.error.fieldErrors.displayName").isString());
    assertThat(count(email)).isZero();
  }

  private ResultActions register(String email, String displayName) throws Exception {
    return mvc.perform(post("/api/v1/auth/register").with(bootstrap(mvc))
        .contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(
            Map.of("email", email, "password", PASSWORD, "displayName", displayName))));
  }

  private long count(String email) {
    return jdbc.queryForObject("SELECT count(*) FROM studymate.users WHERE normalized_email = ?", Long.class, email);
  }

  private static String uniqueEmail() { return "test-" + UUID.randomUUID() + "@example.com"; }
}
