package com.studymate.identity;

import com.studymate.common.api.ApiException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
class RegistrationService {
  private final UserRepository users;
  private final PasswordEncoder passwords;
  private final RegistrationConfiguration.RegistrationProperties properties;

  RegistrationService(UserRepository users, PasswordEncoder passwords,
      RegistrationConfiguration.RegistrationProperties properties) {
    this.users = users;
    this.passwords = passwords;
    this.properties = properties;
  }

  User register(RegistrationRequest request) {
    if (!properties.enabled()) {
      throw new ApiException(HttpStatus.FORBIDDEN, "REGISTRATION_CLOSED",
          "Регистрация пока закрыта.", Map.of());
    }
    // Hash before the single atomic INSERT, without holding a database connection/transaction.
    String hash = passwords.encode(request.password());
    return users.create(UUID.randomUUID(), request.email(), request.displayName(), hash)
        .orElseThrow(() -> new ApiException(HttpStatus.CONFLICT, "EMAIL_ALREADY_EXISTS",
            "Этот email уже используется.", Map.of("email", "Этот email уже используется.")));
  }
}
