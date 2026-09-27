package com.studymate.common.api;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.studymate.config.JsonConfiguration;
import jakarta.servlet.RequestDispatcher;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@WebMvcTest(ApiExceptionHandlerTest.ProbeController.class)
@AutoConfigureMockMvc(addFilters = false)
@Import({ApiExceptionHandler.class, ApiErrorController.class, JsonConfiguration.class,
    ApiExceptionHandlerTest.ProbeController.class})
class ApiExceptionHandlerTest {
  @Autowired MockMvc mvc;

  @Test
  void validationReturnsFieldErrorsWithoutRejectedValues() throws Exception {
    mvc.perform(post("/probe").contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"\"}"))
        .andExpect(status().is(422))
        .andExpect(jsonPath("$.error.code").value("VALIDATION_FAILED"))
        .andExpect(jsonPath("$.error.fieldErrors.title").value("Укажи название."))
        .andExpect(jsonPath("$.error.rejectedValue").doesNotExist())
        .andExpect(header().string("Cache-Control", "no-store"));
  }

  @ParameterizedTest
  @ValueSource(strings = {"{", "{\"title\":}", ""})
  void malformedJsonReturns400(String body) throws Exception {
    mvc.perform(post("/probe").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.error.code").value("MALFORMED_JSON"))
        .andExpect(jsonPath("$.error.fieldErrors").isEmpty());
  }

  @ParameterizedTest
  @ValueSource(strings = {
      "{\"title\":\"Valid\",\"ownerId\":\"untrusted\"}",
      "{\"title\":{\"private\":\"value\"}}", "{\"title\":123}",
      "{\"title\":1.5}", "{\"title\":true}",
      "{\"title\":null}", "{}", "[]"
  })
  void invalidFieldsAndTypesReturn422(String body) throws Exception {
    mvc.perform(post("/probe").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().is(422))
        .andExpect(jsonPath("$.error.code").value("VALIDATION_FAILED"))
        .andExpect(content().string(not(containsString("untrusted"))))
        .andExpect(content().string(not(containsString("MismatchedInputException"))));
  }

  @Test
  void unsupportedContentTypeReturns415() throws Exception {
    mvc.perform(post("/probe").contentType(MediaType.TEXT_PLAIN).content("private input"))
        .andExpect(status().isUnsupportedMediaType())
        .andExpect(jsonPath("$.error.code").value("UNSUPPORTED_MEDIA_TYPE"));
  }

  @Test
  void unsupportedMethodPreservesAllowHeader() throws Exception {
    mvc.perform(get("/probe"))
        .andExpect(status().isMethodNotAllowed())
        .andExpect(header().string("Allow", containsString("POST")))
        .andExpect(jsonPath("$.error.code").value("METHOD_NOT_ALLOWED"));
  }

  @Test
  void missingRouteHasSafeJson() throws Exception {
    mvc.perform(get("/missing"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.error.code").value("NOT_FOUND"))
        .andExpect(jsonPath("$.path").doesNotExist());
  }

  @Test
  void unexpectedExceptionDoesNotExposeDetails() throws Exception {
    mvc.perform(get("/probe/failure"))
        .andExpect(status().isInternalServerError())
        .andExpect(jsonPath("$.error.code").value("INTERNAL_ERROR"))
        .andExpect(content().string(not(containsString("private-secret"))))
        .andExpect(jsonPath("$.trace").doesNotExist());
  }

  @Test
  void unavailableDatabaseHasSafe503() throws Exception {
    mvc.perform(get("/probe/database"))
        .andExpect(status().isServiceUnavailable())
        .andExpect(jsonPath("$.error.code").value("SERVICE_UNAVAILABLE"))
        .andExpect(content().string(not(containsString("private-secret"))));
  }

  @Test
  void servletErrorDispatchAlsoUsesSafeEnvelope() throws Exception {
    mvc.perform(get("/error").requestAttr(RequestDispatcher.ERROR_STATUS_CODE, 500)
            .requestAttr(RequestDispatcher.ERROR_MESSAGE, "private-secret")
            .requestAttr(RequestDispatcher.ERROR_EXCEPTION, new IllegalStateException("private-secret")))
        .andExpect(status().isInternalServerError())
        .andExpect(jsonPath("$.error.code").value("INTERNAL_ERROR"))
        .andExpect(content().string(not(containsString("private-secret"))))
        .andExpect(header().string("Cache-Control", "no-store"));
  }

  // Test-only routes; they are never packaged in the application.
  @RestController
  static class ProbeController {
    @PostMapping("/probe")
    Payload create(@Valid @RequestBody Payload payload) { return payload; }

    @GetMapping("/probe/failure")
    void fail() { throw new IllegalStateException("private-secret SQL and system path"); }

    @GetMapping("/probe/database")
    void database() { throw new DataAccessResourceFailureException("private-secret database URL"); }
  }

  record Payload(@NotBlank(message = "Укажи название.") String title) {}
}
