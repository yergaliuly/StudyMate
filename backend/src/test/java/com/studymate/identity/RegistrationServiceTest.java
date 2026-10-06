package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.studymate.common.api.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.password.PasswordEncoder;

class RegistrationServiceTest {
  @Test
  void configuredAllowlistBindsSeveralEmailsAndAcceptsNormalizedInvitation() {
    var source = new org.springframework.boot.context.properties.source.MapConfigurationPropertySource(java.util.Map.of(
        "studymate.registration.enabled", "true",
        "studymate.registration.allowed-emails", " INVITED@EXAMPLE.COM , SECOND@EXAMPLE.COM "));
    var properties = new org.springframework.boot.context.properties.bind.Binder(source)
        .bind("studymate.registration", RegistrationConfiguration.RegistrationProperties.class).get();
    org.assertj.core.api.Assertions.assertThat(properties.allowedEmails())
        .containsExactlyInAnyOrder("invited@example.com", "second@example.com");
    var repository = mock(UserRepository.class);
    var encoder = mock(PasswordEncoder.class);
    var user = new User(java.util.UUID.randomUUID(), "invited@example.com", "Test");
    org.mockito.Mockito.when(encoder.encode("Example-only password!")).thenReturn("fixture-hash");
    org.mockito.Mockito.when(repository.create(org.mockito.ArgumentMatchers.any(),
        org.mockito.ArgumentMatchers.eq(user.email()), org.mockito.ArgumentMatchers.eq("Test"),
        org.mockito.ArgumentMatchers.eq("fixture-hash"))).thenReturn(java.util.Optional.of(user));
    var registered = new RegistrationService(repository, encoder, properties)
        .register(new RegistrationRequest(" INVITED@EXAMPLE.COM ", "Example-only password!", "Test"));
    org.assertj.core.api.Assertions.assertThat(registered).isEqualTo(user);
  }

  @Test
  void nonInvitedEmailIsRejectedBeforeHashingWithoutRevealingAllowlist() {
    var repository = mock(UserRepository.class);
    var encoder = mock(PasswordEncoder.class);
    var properties = new RegistrationConfiguration.RegistrationProperties(true, java.util.Set.of(" INVITED@EXAMPLE.COM "));
    org.assertj.core.api.Assertions.assertThat(properties.allowedEmails()).containsExactly("invited@example.com");
    org.assertj.core.api.Assertions.assertThat(properties.toString()).doesNotContain("invited@example.com");
    var service = new RegistrationService(repository, encoder, properties);
    assertThatThrownBy(() -> service.register(new RegistrationRequest("other@example.com", "Example-only password!", "Test")))
        .isInstanceOf(ApiException.class).hasMessage("REGISTRATION_CLOSED");
    verifyNoInteractions(repository, encoder);
  }

  @Test
  void closedRegistrationDoesNotHashOrTouchDatabase() {
    var repository = mock(UserRepository.class);
    var encoder = mock(PasswordEncoder.class);
    var service = new RegistrationService(repository, encoder,
        new RegistrationConfiguration.RegistrationProperties(false, java.util.Set.of()));

    assertThatThrownBy(() -> service.register(
        new RegistrationRequest("a@example.com", "Example-only password!", "Test")))
        .isInstanceOf(ApiException.class).hasMessage("REGISTRATION_CLOSED");
    verifyNoInteractions(repository, encoder);
  }
}
