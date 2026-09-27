package com.studymate.subjects;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.studymate.common.api.ApiException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.util.LinkedMultiValueMap;

class SubjectQueryTest {
  @Test
  void defaultsUnicodeTrimAndSafeLargeOffset() {
    var values = new LinkedMultiValueMap<String, String>();
    assertThat(SubjectQuery.parse(values)).isEqualTo(new SubjectQuery("", 1, 20));
    values.add("page", "9007199254740991");
    values.add("pageSize", "100");
    values.add("q", "\uFEFF  SQL  ЯЗЫК\u00A0");
    var query = SubjectQuery.parse(values);
    assertThat(query.q()).isEqualTo("sql  язык");
    assertThat(query.offset()).isEqualTo(900719925474099000L);
  }

  @ParameterizedTest
  @ValueSource(strings = {"", "0", "-1", "+1", "1.0", "1e2", " 1", "١", "9007199254740992", "999999999999999999999999"})
  void rejectsNonCanonicalOrUnsafePageNumbers(String value) {
    var values = new LinkedMultiValueMap<String, String>();
    values.add("page", value);
    assertInvalid(values);
  }

  @Test
  void rejectsUnknownRepeatedOutOfRangeAndInvalidUnicodeParameters() {
    for (var entry : java.util.Map.of("ownerId", "forged", "pageSize", "101", "q", "x".repeat(161)).entrySet()) {
      var values = new LinkedMultiValueMap<String, String>();
      values.add(entry.getKey(), entry.getValue());
      assertInvalid(values);
    }
    for (String q : new String[]{"\uD800", "\0", "\uDC00"}) {
      var values = new LinkedMultiValueMap<String, String>();
      values.add("q", q);
      assertInvalid(values);
    }
    var repeated = new LinkedMultiValueMap<String, String>();
    repeated.add("q", "a"); repeated.add("q", "b");
    assertInvalid(repeated);
  }

  private static void assertInvalid(LinkedMultiValueMap<String, String> values) {
    assertThatThrownBy(() -> SubjectQuery.parse(values)).isInstanceOf(ApiException.class)
        .satisfies(error -> assertThat(((ApiException) error).response().error().code()).isEqualTo("INVALID_QUERY"));
  }
}
