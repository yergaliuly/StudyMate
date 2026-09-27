package com.studymate.identity;

import com.studymate.common.validation.WellFormedUnicode;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record RegistrationRequest(
    @NotBlank(message = "Укажи email.")
    @Size(max = 254, message = "Email должен содержать не больше 254 символов.")
    @Email(message = "Введи корректный email.")
    @WellFormedUnicode String email,
    @NotNull(message = "Введи пароль.")
    @Size(min = 12, max = 128, message = "Пароль должен содержать от 12 до 128 символов.")
    @WellFormedUnicode String password,
    @NotBlank(message = "Укажи имя.")
    @Size(max = 60, message = "Имя должно содержать от 1 до 60 символов.")
    @Pattern(regexp = "[^\\x00]*", message = "Имя содержит недопустимый символ.")
    @WellFormedUnicode String displayName) {

  public RegistrationRequest {
    email = AccountInput.normalizeEmail(email);
    displayName = AccountInput.trim(displayName);
    // Password stays byte-for-byte equivalent after UTF-8 encoding: never trim/normalize it.
  }

  @Override
  public String toString() { return "RegistrationRequest[redacted]"; }
}
