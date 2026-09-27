package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.Validation;
import org.junit.jupiter.api.Test;

class LoginRequestTest {
  @Test
  void passwordBoundsUseUtf16AndPreserveWhitespaceAndUnicode() {
    try (var factory = Validation.buildDefaultValidatorFactory()) {
      var validator = factory.getValidator();
      for (String password : new String[]{" ", "x", "x".repeat(128), "\uD83D\uDE00".repeat(64)}) {
        var request = new LoginRequest(" \uFEFFUSER@Example.com\u00A0", password);
        assertThat(validator.validate(request)).isEmpty();
        assertThat(request.email()).isEqualTo("user@example.com");
        assertThat(request.password()).isEqualTo(password);
      }
      for (String password : new String[]{null, "", "x".repeat(129), "\uD83D", "\uDE00"}) {
        assertThat(validator.validate(new LoginRequest("user@example.com", password))).isNotEmpty();
      }
    }
  }
}
