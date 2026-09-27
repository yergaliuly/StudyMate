package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.crypto.password.PasswordEncoder;

class AccountAuthenticationProviderTest {
  @Test
  void unknownEmailStillPerformsOnePasswordCheck() {
    var users = mock(UserRepository.class);
    var passwords = mock(PasswordEncoder.class);
    when(passwords.encode(anyString())).thenReturn("dummy-hash");
    when(users.credentials("missing@example.com")).thenReturn(Optional.empty());
    var provider = new AccountAuthenticationProvider(users, passwords);
    assertThatThrownBy(() -> provider.authenticate(
        UsernamePasswordAuthenticationToken.unauthenticated(" MISSING@Example.com ", "unchanged password")))
        .isInstanceOf(BadCredentialsException.class);
    verify(passwords).matches("unchanged password", "dummy-hash");
    assertThat(new LoginRequest("a@example.com", "secret").toString()).doesNotContain("secret", "a@example.com");
  }
}
