package com.studymate.subjects;

import com.studymate.common.api.ApiException;
import com.studymate.common.validation.TextInput;
import com.studymate.common.validation.WellFormedUnicodeValidator;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.util.MultiValueMap;

record SubjectQuery(String q, long page, int pageSize) {
  private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

  static SubjectQuery parse(MultiValueMap<String, String> query) {
    if (!Set.of("q", "page", "pageSize").containsAll(query.keySet())
        || query.values().stream().anyMatch(values -> values.size() != 1 || values.getFirst() == null)) throw invalid();
    String q = query.containsKey("q") ? TextInput.trim(query.getFirst("q")) : "";
    if (q.length() > 160 || q.indexOf('\0') >= 0 || !new WellFormedUnicodeValidator().isValid(q, null)) throw invalid();
    long page = number(query, "page", 1, MAX_SAFE_INTEGER);
    int pageSize = (int) number(query, "pageSize", 20, 100);
    return new SubjectQuery(TextInput.searchKey(q), page, pageSize);
  }

  long offset() { return (page - 1) * pageSize; }

  private static long number(MultiValueMap<String, String> query, String name, long fallback, long max) {
    if (!query.containsKey(name)) return fallback;
    String value = query.getFirst(name);
    if (!value.matches("[0-9]+")) throw invalid();
    try {
      long parsed = Long.parseLong(value);
      if (parsed < 1 || parsed > max) throw invalid();
      return parsed;
    } catch (NumberFormatException exception) { throw invalid(); }
  }

  private static ApiException invalid() {
    return new ApiException(HttpStatus.BAD_REQUEST, "INVALID_QUERY", "Проверь параметры поиска и страницы.", Map.of());
  }
}
