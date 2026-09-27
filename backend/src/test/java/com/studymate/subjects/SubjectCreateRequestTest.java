package com.studymate.subjects;

import static org.assertj.core.api.Assertions.assertThat;

import com.studymate.common.validation.TextInput;
import jakarta.validation.Validation;
import java.util.Locale;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class SubjectCreateRequestTest {
  @Test
  void normalizationMatchesJavascriptWhitespaceAndPreservesDescriptionInterior() {
    String spaces = "\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
    var input = request(spaces + "Базы" + spaces + "данных" + spaces);
    input.setDescription(spaces + "SQL  \n tables" + spaces);
    assertThat(input.title()).isEqualTo("Базы данных");
    assertThat(input.description()).isEqualTo("SQL  \n tables");
    assertThat(TextInput.title("\u0085\u180E\u200B")).isEqualTo("\u0085\u180E\u200B");
    Locale before = Locale.getDefault();
    try { Locale.setDefault(Locale.forLanguageTag("tr-TR")); assertThat(TextInput.searchKey("IİЯ")).isEqualTo("ii\u0307я"); }
    finally { Locale.setDefault(before); }
  }

  @Test
  void titleAndDescriptionLengthsUseUtf16AfterNormalizationAndRejectNulOrBrokenUnicode() {
    try (var factory = Validation.buildDefaultValidatorFactory()) {
      var validator = factory.getValidator();
      for (String title : new String[]{"AB", "😀", "x".repeat(60), "😀".repeat(30), "  AB  "}) {
        var input = request(title);
        input.setDescription("😀".repeat(80));
        assertThat(validator.validate(input)).isEmpty();
      }
      for (String title : new String[]{null, "", " ", "A", "x".repeat(61), "😀".repeat(31), "AB\0", "AB\uD800"}) {
        assertThat(validator.validate(request(title))).isNotEmpty();
      }
      for (String description : new String[]{null, "x".repeat(161), "\0", "\uDC00"}) {
        var input = request("Valid"); input.setDescription(description);
        assertThat(validator.validate(input)).isNotEmpty();
      }
    }
  }

  @Test
  void missingDescriptionDefaultsToEmptyButExplicitNullDoesNot() {
    var mapper = JsonMapper.builder().build();
    assertThat(mapper.readValue("{}", SubjectCreateRequest.class).description()).isEmpty();
    assertThat(mapper.readValue("{\"description\":null}", SubjectCreateRequest.class).description()).isNull();
  }

  private static SubjectCreateRequest request(String title) {
    var request = new SubjectCreateRequest();
    request.setTitle(title); request.setIcon("book"); request.setTone("blue");
    return request;
  }
}
