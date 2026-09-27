package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.studymate.common.api.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.password.PasswordEncoder;

class RegistrationServiceTest {
  @Test
  void closedRegistrationDoesNotHashOrTouchDatabase() {
    var repository = mock(UserRepository.class);
    var encoder = mock(PasswordEncoder.class);
    var service = new RegistrationService(repository, encoder,
        new RegistrationConfiguration.RegistrationProperties(false));

    assertThatThrownBy(() -> service.register(
        new RegistrationRequest("a@example.com", "Example-only password!", "Test")))
        .isInstanceOf(ApiException.class).hasMessage("REGISTRATION_CLOSED");
    verifyNoInteractions(repository, encoder);
  }
}
