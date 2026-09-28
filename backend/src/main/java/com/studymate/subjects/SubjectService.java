package com.studymate.subjects;

import com.studymate.common.api.ApiException;
import com.studymate.common.api.ApiResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

@Service
class SubjectService {
  private final SubjectRepository subjects;
  private final SubjectCreationRequests requests;
  private final JsonMapper mapper;

  SubjectService(SubjectRepository subjects, SubjectCreationRequests requests, JsonMapper mapper) {
    this.subjects = subjects;
    this.requests = requests;
    this.mapper = mapper;
  }

  SubjectPage list(UUID owner, SubjectQuery query) { return subjects.list(owner, query); }

  @Transactional(timeout = 10)
  public SubjectCreation create(UUID owner, UUID key, SubjectCreateRequest input) {
    // Transaction-level, non-waiting lock works across processes; commit/rollback releases it.
    if (!requests.tryLock(owner, key)) throw new ApiException(HttpStatus.CONFLICT, "REQUEST_IN_PROGRESS",
        "Запрос ещё выполняется. Повтори его с тем же ключом.", Map.of(), 1);
    String fingerprint = SubjectCreationRequests.fingerprint(mapper.writeValueAsBytes(
        List.of(input.title(), input.description(), input.icon(), input.tone())));
    var saved = requests.find(owner, key);
    if (saved.isPresent()) {
      if (!saved.get().fingerprint().equals(fingerprint)) throw new ApiException(HttpStatus.CONFLICT,
          "IDEMPOTENCY_KEY_REUSED", "Этот ключ уже использован для другого запроса.", Map.of());
      return saved.get().result();
    }
    var subject = subjects.create(owner, input).orElseThrow(() -> new ApiException(HttpStatus.CONFLICT,
        "SUBJECT_TITLE_EXISTS", "Предмет с таким названием уже есть.", Map.of("title", "Выбери другое название.")));
    var result = new SubjectCreation(mapper.writeValueAsString(new ApiResponse<>(subject)), "/api/v1/subjects/" + subject.id());
    requests.save(owner, key, fingerprint, result);
    return result;
  }
}
