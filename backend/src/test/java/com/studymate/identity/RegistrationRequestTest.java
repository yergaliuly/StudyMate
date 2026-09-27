package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;
import java.util.Locale;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class RegistrationRequestTest {
  private static final ValidatorFactory FACTORY = Validation.buildDefaultValidatorFactory();
  private static final Validator VALIDATOR = FACTORY.getValidator();
  private static final String PASSWORD = "Example-only password!";

  @AfterAll
  static void closeValidator() { FACTORY.close(); }

  @Test
  void normalizesEmailAndNameButPreservesPasswordAndInternalSpaces() {
    var request = new RegistrationRequest("\uFEFF I.Student+Tag@EXAMPLE.COM\u00a0",
        "  пароль без trim  ", "\u2003 Айдана  Т.\u00a0");
    assertThat(request.email()).isEqualTo("i.student+tag@example.com");
    assertThat(request.displayName()).isEqualTo("Айдана  Т.");
    assertThat(request.password()).isEqualTo("  пароль без trim  ");
    assertThat(VALIDATOR.validate(request)).isEmpty();
    assertThat(request.toString()).doesNotContain(request.password(), request.email(), request.displayName());
  }

  @Test
  void emailNormalizationDoesNotDependOnMachineLocale() {
    Locale original = Locale.getDefault();
    try {
      Locale.setDefault(Locale.forLanguageTag("tr-TR"));
      assertThat(new RegistrationRequest("I@EXAMPLE.COM", PASSWORD, "Test").email())
          .isEqualTo("i@example.com");
    } finally {
      Locale.setDefault(original);
    }
  }

  @Test
  void preservesDotsAndPlusAliases() {
    assertThat(AccountInput.normalizeEmail("First.Last+Study@example.com"))
        .isEqualTo("first.last+study@example.com");
  }

  @ParameterizedTest
  @MethodSource("validBoundaries")
  void acceptsContractBoundaries(RegistrationRequest request) {
    assertThat(VALIDATOR.validate(request)).isEmpty();
  }

  static Stream<RegistrationRequest> validBoundaries() {
    String longestEmail = "a".repeat(64) + "@" + "b".repeat(63) + "."
        + "c".repeat(63) + "." + "d".repeat(57) + ".com";
    return Stream.of(
        new RegistrationRequest("a@example.com", " ".repeat(12), "A"),
        new RegistrationRequest(longestEmail, "p".repeat(128), "А".repeat(60)),
        new RegistrationRequest("a@example.com", "😀".repeat(64), "😀".repeat(30)));
  }

  @ParameterizedTest
  @MethodSource("invalidFields")
  void rejectsInvalidFields(RegistrationRequest request, String field) {
    assertThat(VALIDATOR.validate(request)).anySatisfy(violation ->
        assertThat(violation.getPropertyPath().toString()).isEqualTo(field));
  }

  static Stream<Arguments> invalidFields() {
    return Stream.of(
        Arguments.of(new RegistrationRequest(null, PASSWORD, "Test"), "email"),
        Arguments.of(new RegistrationRequest(" \u00a0 ", PASSWORD, "Test"), "email"),
        Arguments.of(new RegistrationRequest("not-an-email", PASSWORD, "Test"), "email"),
        Arguments.of(new RegistrationRequest("a".repeat(255) + "@example.com", PASSWORD, "Test"), "email"),
        Arguments.of(new RegistrationRequest("a\u0000@example.com", PASSWORD, "Test"), "email"),
        Arguments.of(new RegistrationRequest("a@example.com", null, "Test"), "password"),
        Arguments.of(new RegistrationRequest("a@example.com", "a".repeat(11), "Test"), "password"),
        Arguments.of(new RegistrationRequest("a@example.com", "a".repeat(129), "Test"), "password"),
        Arguments.of(new RegistrationRequest("a@example.com", "a".repeat(12) + '\uD800', "Test"), "password"),
        Arguments.of(new RegistrationRequest("a@example.com", "a".repeat(12) + '\uDC00', "Test"), "password"),
        Arguments.of(new RegistrationRequest("a@example.com", PASSWORD, null), "displayName"),
        Arguments.of(new RegistrationRequest("a@example.com", PASSWORD, "\uFEFF \u00a0"), "displayName"),
        Arguments.of(new RegistrationRequest("a@example.com", PASSWORD, "a".repeat(61)), "displayName"),
        Arguments.of(new RegistrationRequest("a@example.com", PASSWORD, "😀".repeat(31)), "displayName"),
        Arguments.of(new RegistrationRequest("a@example.com", PASSWORD, "Name\u0000"), "displayName"),
        Arguments.of(new RegistrationRequest("a@example.com", PASSWORD, "Name" + '\uD800'), "displayName"));
  }
}
