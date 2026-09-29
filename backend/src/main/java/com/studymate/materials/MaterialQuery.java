package com.studymate.materials;

import com.studymate.common.validation.TextInput;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.util.MultiValueMap;

record MaterialQuery(UUID subjectId, String q, long page, int pageSize) {
  static MaterialQuery parse(MultiValueMap<String,String> values) {
    if (!Set.of("subjectId","q","page","pageSize").containsAll(values.keySet())
        || values.values().stream().anyMatch(v -> v.size() != 1 || v.getFirst() == null)) throw invalid();
    String q = TextInput.trim(values.getFirst("q"));
    if (q == null) q = "";
    if (q.length() > 160 || !MaterialInput.textValid(q)) throw invalid();
    UUID subject = values.containsKey("subjectId") ? MaterialInput.id(values.getFirst("subjectId")) : null;
    return new MaterialQuery(subject, TextInput.searchKey(q), number(values.getFirst("page"),1,9_007_199_254_740_991L),
        (int)number(values.getFirst("pageSize"),20,100));
  }
  private static long number(String value, long fallback, long max) {
    if (value == null) return fallback;
    try {
      if (!value.matches("[0-9]+")) throw invalid();
      long n = Long.parseLong(value);
      if (n < 1 || n > max) throw invalid();
      return n;
    } catch (NumberFormatException e) { throw invalid(); }
  }
  static RuntimeException invalid() { return MaterialInput.error(HttpStatus.BAD_REQUEST,"INVALID_QUERY","Проверь параметры списка."); }
}
