package com.studymate.common.validation;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

public class WellFormedUnicodeValidator implements ConstraintValidator<WellFormedUnicode, String> {
  @Override
  public boolean isValid(String value, ConstraintValidatorContext context) {
    if (value == null) { return true; }
    // UTF-8 encoders otherwise silently replace lone surrogates, including in passwords.
    for (int index = 0; index < value.length(); index++) {
      char unit = value.charAt(index);
      if (Character.isHighSurrogate(unit)) {
        if (++index == value.length() || !Character.isLowSurrogate(value.charAt(index))) { return false; }
      } else if (Character.isLowSurrogate(unit)) {
        return false;
      }
    }
    return true;
  }
}
