package com.studymate.identity;

import com.studymate.common.api.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;

/** Identity module boundary: always resolve the account from the authenticated session. */
@Component
public class CurrentAccount {
  private final UserRepository users;
  CurrentAccount(UserRepository users) { this.users = users; }

  public UserResponse requireUser(Authentication authentication, HttpServletRequest request) {
    return users.findById(UUID.fromString(authentication.getName())).map(UserResponse::from)
        .orElseThrow(() -> {
          SecurityContextHolder.clearContext();
          var session = request.getSession(false);
          if (session != null) session.invalidate();
          return new ApiException(HttpStatus.UNAUTHORIZED, "AUTHENTICATION_REQUIRED", "Войди в аккаунт.", Map.of());
        });
  }
}
