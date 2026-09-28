package com.studymate.subjects;

import com.fasterxml.jackson.annotation.JsonSetter;
import com.fasterxml.jackson.annotation.Nulls;
import com.studymate.common.api.ApiException;
import com.studymate.common.validation.TextInput;
import com.studymate.common.validation.WellFormedUnicode;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.util.Map;
import org.springframework.http.HttpStatus;

/** Missing fields are unchanged; explicit null is invalid, including description. */
public final class SubjectPatchRequest {
  @NotNull(message = "Укажи текущую версию предмета.")
  @Positive(message = "Версия должна быть положительным целым числом.")
  @Max(value = 9_007_199_254_740_991L, message = "Версия выходит за допустимый диапазон.")
  private Long version;

  @Size(min = 2, max = 60, message = "Название должно содержать от 2 до 60 символов.")
  @Pattern(regexp = "[^\\x00]*", message = "Название содержит недопустимый символ.")
  @WellFormedUnicode
  private String title;

  @Size(max = 160, message = "Описание должно содержать не больше 160 символов.")
  @Pattern(regexp = "[^\\x00]*", message = "Описание содержит недопустимый символ.")
  @WellFormedUnicode
  private String description;

  @Pattern(regexp = "book|database|languages|code", message = "Выбери иконку из допустимых значений.")
  private String icon;

  @Pattern(regexp = "blue|purple|indigo|green", message = "Выбери цвет из допустимых значений.")
  private String tone;

  @JsonSetter public void setVersion(Long value) { version = value; }
  @JsonSetter(nulls = Nulls.FAIL) public void setTitle(String value) { title = TextInput.title(value); }
  @JsonSetter(nulls = Nulls.FAIL) public void setDescription(String value) { description = TextInput.trim(value); }
  @JsonSetter(nulls = Nulls.FAIL) public void setIcon(String value) { icon = value; }
  @JsonSetter(nulls = Nulls.FAIL) public void setTone(String value) { tone = value; }
  public Long version() { return version; }

  void requireChanges() {
    if (title == null && description == null && icon == null && tone == null) {
      throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "VALIDATION_FAILED",
          "Передай хотя бы одно изменяемое поле предмета.", Map.of());
    }
  }

  SubjectCreateRequest applyTo(SubjectResponse subject) {
    var values = new SubjectCreateRequest();
    values.setTitle(title == null ? subject.title() : title);
    values.setDescription(description == null ? subject.description() : description);
    values.setIcon(icon == null ? subject.icon() : icon);
    values.setTone(tone == null ? subject.tone() : tone);
    return values;
  }

  @Override public String toString() { return "SubjectPatchRequest[redacted]"; }
}
