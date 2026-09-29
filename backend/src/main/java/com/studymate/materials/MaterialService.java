package com.studymate.materials;

import com.studymate.common.api.ApiException;
import java.io.UncheckedIOException;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

@Service
class MaterialService {
  private final MaterialRepository repository;
  private final ObjectStorage storage;
  private final JsonMapper json;
  MaterialService(MaterialRepository repository, ObjectStorage storage, JsonMapper json) {
    this.repository = repository; this.storage = storage; this.json = json;
  }
  record Upload(UUID id, String body) {}
  MaterialResponse get(UUID owner, UUID id) { return repository.get(owner,id); }
  MaterialRepository.Page list(UUID owner, MaterialQuery query) { return repository.list(owner,query); }
  MaterialRepository.Usage usage(UUID owner) { return repository.usage(owner); }
  MaterialResponse rename(UUID owner, UUID id, String title, long version) { return repository.rename(owner,id,title,version); }
  Upload upload(UUID owner, UUID key, MaterialInput input) throws Exception {
    requireStorage();
    String fingerprint = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(
        List.of(input.subjectId(),input.title(),input.fileName(),input.sizeBytes(),input.sha256()))));
    var reserved = repository.reserve(owner,key,input,fingerprint);
    if (reserved.response() != null) return new Upload(reserved.id(),reserved.response());
    try {
      storage.put(reserved.objectKey(),input.sizeBytes(),input.sha256(),() -> {
        try { return input.file().getInputStream(); } catch (java.io.IOException failure) { throw new UncheckedIOException(failure); }
      });
      return new Upload(reserved.id(),repository.stored(owner,reserved.id()));
    } catch (RuntimeException failure) {
      // Even if this write fails, the committed reservation expires and is found after restart.
      try { repository.delete(owner,reserved.id()); } catch (RuntimeException ignored) { /* Durable expiry is the fallback. */ }
      if (failure instanceof ApiException api) throw api;
      throw MaterialInput.error(HttpStatus.SERVICE_UNAVAILABLE,"UPLOAD_FAILED","Загрузка не подтверждена. Обнови список и дождись очистки резерва.");
    }
  }
  @org.springframework.transaction.annotation.Transactional(timeout = 10)
  public ObjectStorage.Download download(UUID owner, UUID id) {
    // Signing is local (static credentials), so a short row lock can serialize it with DELETE without a network call.
    var item = repository.object(owner,id,true);
    if (item.state().equals("deleted")) throw MaterialRepository.notFound();
    if (!item.state().equals("stored")) throw MaterialInput.error(HttpStatus.CONFLICT,"MATERIAL_NOT_AVAILABLE","Оригинал пока недоступен.");
    requireStorage();
    try { return storage.download(item.objectKey()); }
    catch (StorageFailure failure) { throw unavailable(); }
  }
  MaterialRepository.Deletion delete(UUID owner, UUID id) {
    repository.get(owner,id);
    requireStorage();
    return repository.delete(owner,id);
  }
  void requireStorage() { if (!storage.enabled()) throw unavailable(); }
  static ApiException unavailable() { return MaterialInput.error(HttpStatus.SERVICE_UNAVAILABLE,"STORAGE_UNAVAILABLE","Хранилище файлов недоступно."); }
}
