package com.studymate.identity;

import java.util.Locale;
import com.studymate.common.validation.TextInput;

final class AccountInput {
  private AccountInput() {}

  static String trim(String value) {
    return TextInput.trim(value);
  }

  static String normalizeEmail(String value) {
    String trimmed = trim(value);
    return trimmed == null ? null : trimmed.toLowerCase(Locale.ROOT);
  }
}
