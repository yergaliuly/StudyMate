package com.studymate.pilot;

import com.studymate.common.api.ApiErrorWriter;
import com.studymate.common.api.ApiErrors;
import com.studymate.common.api.ApiException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.springframework.dao.DataAccessException;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.transaction.TransactionException;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

/** Runs after authorization; unauthorized clients cannot spend another account's quota. */
public final class AccountRequestLimitFilter extends OncePerRequestFilter {
  private final PilotLimits limits;
  private final JsonMapper mapper;
  public AccountRequestLimitFilter(PilotLimits limits, JsonMapper mapper) { this.limits=limits; this.mapper=mapper; }
  @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    var auth = SecurityContextHolder.getContext().getAuthentication();
    if (request.getServletPath().startsWith("/api/") && auth != null && auth.isAuthenticated()
        && !(auth instanceof AnonymousAuthenticationToken)) {
      try { limits.accountRequest(UUID.fromString(auth.getName())); }
      catch (ApiException failure) {
        response.setHeader("Retry-After", failure.retryAfterSeconds().toString());
        ApiErrorWriter.write(response, mapper, failure.status().value(), failure.response()); return;
      } catch (DataAccessException | TransactionException failure) {
        ApiErrorWriter.write(response, mapper, 503, ApiErrors.forStatus(503)); return;
      }
    }
    chain.doFilter(request, response);
  }
}
