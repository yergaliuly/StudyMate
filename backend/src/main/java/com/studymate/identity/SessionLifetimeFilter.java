package com.studymate.identity;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import org.springframework.web.filter.OncePerRequestFilter;

/** Runs after JDBC session loading and before Security/CSRF read any session attributes. */
public final class SessionLifetimeFilter extends OncePerRequestFilter {
  static final String AUTHENTICATED_AT = "studymate.authenticatedAt";
  static final Duration MAX_AGE = Duration.ofHours(12);
  private final Clock clock;

  public SessionLifetimeFilter(Clock clock) { this.clock = clock; }

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
      FilterChain chain) throws ServletException, IOException {
    var session = request.getSession(false);
    if (session != null) {
      Object authenticatedAt = session.getAttribute(AUTHENTICATED_AT);
      long startedAt = authenticatedAt instanceof Long value ? value : session.getCreationTime();
      if (clock.millis() - startedAt >= MAX_AGE.toMillis()) session.invalidate();
    }
    chain.doFilter(request, response);
  }
}
