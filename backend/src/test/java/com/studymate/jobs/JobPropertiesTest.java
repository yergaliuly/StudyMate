package com.studymate.jobs;

import static org.assertj.core.api.Assertions.assertThat;
import jakarta.validation.Validation;
import org.junit.jupiter.api.Test;

class JobPropertiesTest {
  @Test void rejectsLeaseAndRetrySettingsThatCannotBeExecutedSafely() {
    try (var factory = Validation.buildDefaultValidatorFactory()) {
      var validator = factory.getValidator();
      assertThat(validator.validate(new JobProperties(1000, 5000, 30, 120, 3, 2, 60))).isEmpty();
      for (var invalid : new JobProperties[]{
          new JobProperties(10, 5000, 30, 120, 3, 2, 60),
          new JobProperties(1000, 5000, 1, 120, 3, 2, 60),
          new JobProperties(1000, 5000, 30, 10, 3, 2, 60),
          new JobProperties(1000, 5000, 30, 120, 11, 2, 60),
          new JobProperties(1000, 5000, 30, 120, 3, 60, 2)}) {
        assertThat(validator.validate(invalid)).isNotEmpty();
      }
    }
  }
}
