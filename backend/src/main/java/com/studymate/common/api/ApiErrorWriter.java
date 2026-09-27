package com.studymate.common.api;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.springframework.http.MediaType;
import tools.jackson.databind.json.JsonMapper;

/** JSON errors for failures occurring outside Spring MVC. */
public final class ApiErrorWriter {
  private ApiErrorWriter() {}

  public static void write(HttpServletResponse response, JsonMapper mapper,
      int status, ApiErrorResponse body) throws IOException {
    response.setStatus(status);
    response.setContentType(MediaType.APPLICATION_JSON_VALUE);
    response.setCharacterEncoding(StandardCharsets.UTF_8.name());
    response.setHeader("Cache-Control", "no-store");
    mapper.writeValue(response.getOutputStream(), body);
  }
}
