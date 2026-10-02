package com.studymate.quizzes;

import com.studymate.common.api.ApiException;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.util.MultiValueMap;

record QuizQuery(long page, int pageSize) {
  static QuizQuery parse(MultiValueMap<String,String> query) {
    if (!Set.of("page", "pageSize").containsAll(query.keySet())
        || query.values().stream().anyMatch(v -> v.size() != 1 || v.getFirst() == null)) throw invalid();
    return new QuizQuery(number(query.getFirst("page"), 1, 9_007_199_254_740_991L),
        (int) number(query.getFirst("pageSize"), 20, 100));
  }
  long offset() { return (page - 1) * pageSize; }
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
    return new ApiException(HttpStatus.BAD_REQUEST, "INVALID_QUERY", "Проверь параметры списка тестов.", Map.of());
  }
}
