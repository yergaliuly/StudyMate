package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.studymate.common.api.ApiExceptionHandler;
import com.studymate.config.BootstrapSecurityConfiguration;
import com.studymate.config.JsonConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(RegistrationController.class)
@Import({BootstrapSecurityConfiguration.class, JsonConfiguration.class, ApiExceptionHandler.class})
class RegistrationControllerTest {
  private static final String BODY = """
      {"email":" Student@Example.com ","password":"  Example-only pass!  ","displayName":" Айдана "}
      """;
  @Autowired MockMvc mvc;
  @MockitoBean RegistrationService registrations;

  @Test
  void normalizesInputAndReturnsOnlyPublicUserFields() throws Exception {
    UUID id = UUID.randomUUID();
    when(registrations.register(any())).thenReturn(new User(id, "student@example.com", "Айдана"));
    var result = mvc.perform(post("/api/v1/auth/register").with(csrf().asHeader())
            .contentType(MediaType.APPLICATION_JSON).content(BODY))
        .andExpect(status().isCreated())
        .andExpect(header().string("Cache-Control", "no-store"))
        .andExpect(jsonPath("$.data.id").value(id.toString()))
        .andExpect(jsonPath("$.data.email").value("student@example.com"))
        .andExpect(jsonPath("$.data.displayName").value("Айдана"))
        .andExpect(jsonPath("$.data.length()").value(3))
        .andExpect(jsonPath("$.data.password").doesNotExist())
        .andExpect(jsonPath("$.data.passwordHash").doesNotExist()).andReturn();
    var captured = ArgumentCaptor.forClass(RegistrationRequest.class);
    verify(registrations).register(captured.capture());
    assertThat(captured.getValue().email()).isEqualTo("student@example.com");
    assertThat(captured.getValue().displayName()).isEqualTo("Айдана");
    assertThat(captured.getValue().password()).isEqualTo("  Example-only pass!  ");
    assertThat(result.getRequest().getSession().getAttribute("SPRING_SECURITY_CONTEXT")).isNull();
  }

  @Test
  void missingOrInvalidCsrfNeverCallsRegistration() throws Exception {
    mvc.perform(post("/api/v1/auth/register").contentType(MediaType.APPLICATION_JSON).content(BODY))
        .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("CSRF_INVALID"));
    mvc.perform(post("/api/v1/auth/register").with(csrf().useInvalidToken().asHeader())
            .contentType(MediaType.APPLICATION_JSON).content(BODY))
        .andExpect(status().isForbidden()).andExpect(jsonPath("$.error.code").value("CSRF_INVALID"));
    verifyNoInteractions(registrations);
  }

  @ParameterizedTest
  @ValueSource(strings = {
      "{}", "null", "[]",
      "{\"email\":\"bad\",\"password\":\"short\",\"displayName\":\" \"}",
      "{\"email\":123,\"password\":\"Example-only pass!\",\"displayName\":\"Test\"}",
      "{\"email\":\"a@example.com\",\"password\":false,\"displayName\":\"Test\"}",
      "{\"email\":\"a@example.com\",\"password\":null,\"displayName\":\"Test\"}",
      "{\"email\":\"a@example.com\",\"password\":\"Example-only pass!\",\"displayName\":{}}",
      "{\"email\":\"a@example.com\",\"password\":\"Example-only pass!\",\"displayName\":\"Test\",\"id\":\"client-id\"}"
  })
  void invalidFieldsNeverReachHashing(String body) throws Exception {
    mvc.perform(post("/api/v1/auth/register").with(csrf().asHeader())
            .contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().is(422)).andExpect(jsonPath("$.error.code").value("VALIDATION_FAILED"));
    verifyNoInteractions(registrations);
  }

  @Test
  void validationUsesContractFieldNames() throws Exception {
    mvc.perform(post("/api/v1/auth/register").with(csrf().asHeader())
            .contentType(MediaType.APPLICATION_JSON).content("{}"))
        .andExpect(status().is(422))
        .andExpect(jsonPath("$.error.fieldErrors.email").isString())
        .andExpect(jsonPath("$.error.fieldErrors.password").isString())
        .andExpect(jsonPath("$.error.fieldErrors.displayName").isString());
  }

  @Test
  void malformedJsonAndWrongContentTypeUseSafeErrors() throws Exception {
    mvc.perform(post("/api/v1/auth/register").with(csrf().asHeader())
            .contentType(MediaType.APPLICATION_JSON).content("{"))
        .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("MALFORMED_JSON"));
    mvc.perform(post("/api/v1/auth/register").with(csrf().asHeader())
            .contentType(MediaType.TEXT_PLAIN).content(BODY))
        .andExpect(status().isUnsupportedMediaType())
        .andExpect(jsonPath("$.error.code").value("UNSUPPORTED_MEDIA_TYPE"));
    verifyNoInteractions(registrations);
  }
}
