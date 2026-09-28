package com.studymate.subjects;

import com.studymate.common.api.ApiException;
import com.studymate.common.api.ApiResponse;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
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

  SubjectResponse get(UUID owner, UUID id) {
    return subjects.find(owner, id, false).orElseThrow(SubjectService::notFound);
  }

  @Transactional(timeout = 10)
  public SubjectResponse update(UUID owner, UUID id, SubjectPatchRequest input) {
    input.requireChanges();
    var current = subjects.find(owner, id, true).orElseThrow(SubjectService::notFound);
    if (current.version() != input.version()) {
      throw new ApiException(HttpStatus.CONFLICT, "SUBJECT_VERSION_CONFLICT",
          "Предмет уже изменён. Загрузи актуальные данные перед повторным сохранением.", Map.of());
    }
    try {
      return subjects.update(owner, id, input.applyTo(current));
    } catch (DuplicateKeyException exception) {
      throw titleExists();
    }
  }

  @Transactional(timeout = 10)
  public void delete(UUID owner, UUID id) {
    try {
      if (!subjects.delete(owner, id)) throw notFound();
    } catch (DataIntegrityViolationException exception) {
      for (Throwable cause = exception; cause != null; cause = cause.getCause()) {
        if (cause instanceof SQLException sql && "23503".equals(sql.getSQLState())) {
          throw new ApiException(HttpStatus.CONFLICT, "SUBJECT_NOT_EMPTY",
              "Сначала удали материалы предмета и дождись завершения их очистки.", Map.of());
        }
      }
      throw exception;
    }
  }

  private static ApiException notFound() {
    return new ApiException(HttpStatus.NOT_FOUND, "SUBJECT_NOT_FOUND", "Предмет не найден.", Map.of());
  }

  private static ApiException titleExists() {
    return new ApiException(HttpStatus.CONFLICT, "SUBJECT_TITLE_EXISTS",
        "Предмет с таким названием уже есть.", Map.of("title", "Выбери другое название."));
  }

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
    var subject = subjects.create(owner, input).orElseThrow(SubjectService::titleExists);
    var result = new SubjectCreation(mapper.writeValueAsString(new ApiResponse<>(subject)), "/api/v1/subjects/" + subject.id());
    requests.save(owner, key, fingerprint, result);
    return result;
  }
}
