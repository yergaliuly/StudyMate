package com.studymate.identity;

import java.util.List;
import java.util.UUID;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

@Component
final class AccountAuthenticationProvider implements AuthenticationProvider {
  private final UserRepository users;
  private final PasswordEncoder passwords;
  private final String dummyHash;

  AccountAuthenticationProvider(UserRepository users, PasswordEncoder passwords) {
    this.users = users;
    this.passwords = passwords;
    this.dummyHash = passwords.encode(UUID.randomUUID().toString());
  }

  @Override
  public Authentication authenticate(Authentication authentication) {
    var account = users.credentials(AccountInput.normalizeEmail(authentication.getName()));
    // Also do the expensive hash check for unknown email; never report which field was wrong.
    boolean matches = passwords.matches((String) authentication.getCredentials(),
        account.map(UserRepository.Credentials::passwordHash).orElse(dummyHash));
    if (account.isEmpty() || !matches) throw new BadCredentialsException("Invalid credentials");
    // Only the immutable account ID is serialized into the session, never a hash or password.
    return UsernamePasswordAuthenticationToken.authenticated(account.get().id().toString(), null,
        List.of(new SimpleGrantedAuthority("ROLE_USER")));
  }

  @Override
  public boolean supports(Class<?> authentication) {
    return UsernamePasswordAuthenticationToken.class.isAssignableFrom(authentication);
  }
}
