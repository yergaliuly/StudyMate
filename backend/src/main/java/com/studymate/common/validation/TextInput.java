package com.studymate.common.validation;

import java.util.Locale;
import java.util.regex.Pattern;

/** ECMAScript whitespace, shared with the JavaScript forms (not Java String.trim/strip). */
public final class TextInput {
  private static final String SPACE = "[\\x09-\\x0D\\x20\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";
  private static final Pattern EDGES = Pattern.compile("^" + SPACE + "+|" + SPACE + "+$");
  private static final Pattern RUN = Pattern.compile(SPACE + "+");
  private TextInput() {}

  public static String trim(String value) { return value == null ? null : EDGES.matcher(value).replaceAll(""); }
  public static String title(String value) { return value == null ? null : RUN.matcher(trim(value)).replaceAll(" "); }
  public static String searchKey(String value) { return value.toLowerCase(Locale.ROOT); }
}
