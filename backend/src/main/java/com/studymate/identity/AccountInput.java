package com.studymate.identity;

import java.util.Locale;
import java.util.regex.Pattern;

final class AccountInput {
  // Same boundary whitespace as JavaScript String.trim(), including NBSP and BOM.
  private static final Pattern BOUNDARY_WHITESPACE = Pattern.compile(
      "^[\\x09-\\x0D\\x20\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+"
      + "|[\\x09-\\x0D\\x20\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+$");

  private AccountInput() {}

  static String trim(String value) {
    return value == null ? null : BOUNDARY_WHITESPACE.matcher(value).replaceAll("");
  }

  static String normalizeEmail(String value) {
    String trimmed = trim(value);
    return trimmed == null ? null : trimmed.toLowerCase(Locale.ROOT);
  }
}
