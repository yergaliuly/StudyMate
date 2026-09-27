package com.studymate.common.validation;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.RECORD_COMPONENT})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = WellFormedUnicodeValidator.class)
public @interface WellFormedUnicode {
  String message() default "Строка содержит некорректный Unicode.";
  Class<?>[] groups() default {};
  Class<? extends Payload>[] payload() default {};
}
