package com.studymate.subjects;

import com.fasterxml.jackson.annotation.JsonSetter;
import com.studymate.common.validation.TextInput;
import com.studymate.common.validation.WellFormedUnicode;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** Setters distinguish absent description (empty string) from an explicit, invalid null. */
public final class SubjectCreateRequest {
  @NotNull(message = "Укажи название.")
  @Size(min = 2, max = 60, message = "Название должно содержать от 2 до 60 символов.")
  @Pattern(regexp = "[^\\x00]*", message = "Название содержит недопустимый символ.")
  @WellFormedUnicode
  private String title;

  @NotNull(message = "Описание должно быть строкой.")
  @Size(max = 160, message = "Описание должно содержать не больше 160 символов.")
  @Pattern(regexp = "[^\\x00]*", message = "Описание содержит недопустимый символ.")
  @WellFormedUnicode
  private String description = "";

  @NotNull(message = "Выбери иконку.")
  @Pattern(regexp = "book|database|languages|code", message = "Выбери иконку из допустимых значений.")
  private String icon;

  @NotNull(message = "Выбери цвет.")
  @Pattern(regexp = "blue|purple|indigo|green", message = "Выбери цвет из допустимых значений.")
  private String tone;

  @JsonSetter public void setTitle(String value) { title = TextInput.title(value); }
  @JsonSetter public void setDescription(String value) { description = TextInput.trim(value); }
  @JsonSetter public void setIcon(String value) { icon = value; }
  @JsonSetter public void setTone(String value) { tone = value; }
  public String title() { return title; }
  public String description() { return description; }
  public String icon() { return icon; }
  public String tone() { return tone; }
  @Override public String toString() { return "SubjectCreateRequest[redacted]"; }
}
