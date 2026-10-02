package com.studymate.attempts;

import com.studymate.common.api.ApiException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;

record SubmitRequest(
    @NotNull(message = "Передай answers; пустой массив означает пропуск всех вопросов.")
    @Size(max = 10, message = "В тесте только 10 вопросов.") List<@NotNull @Valid Answer> answers) {
  static final String UUID_PATTERN = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
  record Answer(@NotNull @Pattern(regexp = UUID_PATTERN) String questionId,
                @Pattern(regexp = UUID_PATTERN) String optionId) {}

  Map<UUID, UUID> selections() {
    var result = new HashMap<UUID, UUID>();
    for (var answer : answers) {
      UUID question = UUID.fromString(answer.questionId());
      if (result.containsKey(question)) throw invalid("Вопрос не должен повторяться в answers.");
      result.put(question, answer.optionId() == null ? null : UUID.fromString(answer.optionId()));
    }
    return result;
  }
  static ApiException invalid(String message) {
    return new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "VALIDATION_FAILED", "Проверь ответы.", Map.of("answers", message));
  }
  @Override public String toString() { return "SubmitRequest[redacted]"; }
}
