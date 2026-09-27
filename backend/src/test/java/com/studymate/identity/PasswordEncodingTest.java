package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.password.PasswordEncoder;

class PasswordEncodingTest {
  private final PasswordEncoder encoder = new RegistrationConfiguration().passwordEncoder();

  @Test
  void usesArgon2idAndIndependentSalt() {
    String password = "Example-only password!";
    String first = encoder.encode(password);
    String second = encoder.encode(password);
    assertThat(first).startsWith("{argon2id}$argon2id$v=19$m=19456,t=2,p=1$");
    assertThat(first).isNotEqualTo(second).doesNotContain(password);
    assertThat(encoder.matches(password, first)).isTrue();
    assertThat(encoder.matches(password, second)).isTrue();
    assertThat(encoder.matches("Different password!", first)).isFalse();
  }

  @Test
  void doesNotTrimNormalizeOrTruncateLongUnicodePasswords() {
    String password = "  é" + "😀".repeat(60) + "END  ";
    String hash = encoder.encode(password);
    assertThat(encoder.matches(password, hash)).isTrue();
    assertThat(encoder.matches(password.trim(), hash)).isFalse();
    assertThat(encoder.matches(password.replace("é", "e\u0301"), hash)).isFalse();
    assertThat(encoder.matches(password.replace("END", "BAD"), hash)).isFalse();
  }
}
