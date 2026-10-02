package com.studymate.attempts;

import com.studymate.common.api.ApiException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.util.MultiValueMap;

record AttemptQuery(long page, int pageSize, UUID materialId, UUID quizId, String status) {
  static AttemptQuery parse(MultiValueMap<String,String> query) {
    if (!Set.of("page", "pageSize", "materialId", "quizId", "status").containsAll(query.keySet())
        || query.values().stream().anyMatch(v -> v.size() != 1 || v.getFirst() == null)) throw invalid();
    String status = query.getFirst("status");
    if (status != null && !Set.of("in_progress", "completed").contains(status)) throw invalid();
    return new AttemptQuery(number(query.getFirst("page"), 1, 9_007_199_254_740_991L),
        (int) number(query.getFirst("pageSize"), 20, 100), uuid(query.getFirst("materialId")), uuid(query.getFirst("quizId")), status);
  }
  long offset() { return (page - 1) * pageSize; }
  private static UUID uuid(String value) {
    if (value == null) return null;
    if (!value.matches(SubmitRequest.UUID_PATTERN)) throw invalid();
    return UUID.fromString(value);
  }
  private static long number(String value, long fallback, long max) {
    if (value == null) return fallback;
    try {
      if (!value.matches("[0-9]+")) throw invalid();
      long n = Long.parseLong(value);
      if (n < 1 || n > max) throw invalid();
      return n;
    } catch (NumberFormatException failure) { throw invalid(); }
  }
  private static ApiException invalid() {
    return new ApiException(HttpStatus.BAD_REQUEST, "INVALID_QUERY", "Проверь параметры истории попыток.", Map.of());
  }
}
