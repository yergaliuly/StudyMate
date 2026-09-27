package com.studymate.identity;

import com.studymate.common.validation.WellFormedUnicode;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record LoginRequest(
    @NotBlank(message = "Укажи email.")
    @Size(max = 254, message = "Email должен содержать не больше 254 символов.")
    @Email(message = "Введи корректный email.")
    @WellFormedUnicode String email,
    @NotNull(message = "Введи пароль.")
    @Size(min = 1, max = 128, message = "Пароль должен содержать от 1 до 128 символов.")
    @WellFormedUnicode String password) {
  public LoginRequest { email = AccountInput.normalizeEmail(email); }

  @Override
  public String toString() { return "LoginRequest[redacted]"; }
}
