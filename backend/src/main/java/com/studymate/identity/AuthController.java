package com.studymate.identity;

import com.studymate.common.api.ApiResponse;
import com.studymate.pilot.PilotLimits;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import java.time.Clock;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.session.SessionAuthenticationStrategy;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
class AuthController {
  private final AuthenticationManager authenticationManager;
  private final SessionAuthenticationStrategy sessions;
  private final SecurityContextRepository contexts;
  private final CurrentAccount accounts;
  private final Clock clock;
  private final PilotLimits limits;

  AuthController(AuthenticationManager authenticationManager, SessionAuthenticationStrategy sessions,
      SecurityContextRepository contexts, CurrentAccount accounts, Clock clock, PilotLimits limits) {
    this.authenticationManager = authenticationManager;
    this.sessions = sessions;
    this.contexts = contexts;
    this.accounts = accounts;
    this.clock = clock;
    this.limits = limits;
  }

  record CsrfResponse(String headerName, String token) {
    @Override public String toString() { return "CsrfResponse[redacted]"; }
  }

  @GetMapping("/api/v1/auth/csrf")
  ResponseEntity<ApiResponse<CsrfResponse>> csrf(CsrfToken token) {
    return ResponseEntity.ok().header("Cache-Control", "no-store")
        .body(new ApiResponse<>(new CsrfResponse(token.getHeaderName(), token.getToken())));
  }

  @PostMapping(path = "/api/v1/auth/login", consumes = MediaType.APPLICATION_JSON_VALUE)
  ResponseEntity<ApiResponse<UserResponse>> login(@Valid @RequestBody LoginRequest body,
      HttpServletRequest request, HttpServletResponse response) {
    limits.loginEmail(body.email());
    var input = UsernamePasswordAuthenticationToken.unauthenticated(body.email(), body.password());
    Authentication authentication;
    try {
      authentication = authenticationManager.authenticate(input);
    } finally {
      input.eraseCredentials();
    }
    var user = accounts.requireUser(authentication, request);
    sessions.onAuthentication(authentication, request, response);
    request.getSession().setAttribute(SessionLifetimeFilter.AUTHENTICATED_AT, clock.millis());
    var context = SecurityContextHolder.createEmptyContext();
    context.setAuthentication(authentication);
    SecurityContextHolder.setContext(context);
    contexts.saveContext(context, request, response);
    return ResponseEntity.ok().header("Cache-Control", "no-store").body(new ApiResponse<>(user));
  }

  @GetMapping("/api/v1/auth/me")
  ResponseEntity<ApiResponse<UserResponse>> me(Authentication authentication, HttpServletRequest request) {
    return ResponseEntity.ok().header("Cache-Control", "no-store")
        .body(new ApiResponse<>(accounts.requireUser(authentication, request)));
  }
}
