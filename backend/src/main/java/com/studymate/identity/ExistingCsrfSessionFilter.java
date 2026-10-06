package com.studymate.identity;

import com.studymate.common.api.ApiErrorResponse;
import com.studymate.common.api.ApiErrorWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

/** Unsafe requests must reuse bootstrap's session, never allocate a session just to reject CSRF. */
public final class ExistingCsrfSessionFilter extends OncePerRequestFilter {
  private final HttpSessionCsrfTokenRepository tokens;
  private final JsonMapper mapper;
  public ExistingCsrfSessionFilter(HttpSessionCsrfTokenRepository tokens, JsonMapper mapper) {
    this.tokens = tokens;
    this.mapper = mapper;
  }
  @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    if (CsrfFilter.DEFAULT_CSRF_MATCHER.matches(request) && tokens.loadToken(request) == null) {
      ApiErrorWriter.write(response, mapper, 403,
          ApiErrorResponse.of("CSRF_INVALID", "Обнови страницу и повтори действие."));
      return;
    }
    chain.doFilter(request, response);
  }
}
