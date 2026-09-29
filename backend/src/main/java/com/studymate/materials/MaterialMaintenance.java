package com.studymate.materials;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name="studymate.materials.maintenance-enabled",havingValue="true",matchIfMissing=true)
class MaterialMaintenance {
  private static final Logger log = LoggerFactory.getLogger(MaterialMaintenance.class);
  private final MaterialRepository repository;
  private final ObjectStorage storage;
  MaterialMaintenance(MaterialRepository repository, ObjectStorage storage) { this.repository=repository; this.storage=storage; }
  @Scheduled(initialDelay=10000,fixedDelay=60000)
  void recover() {
    if (!storage.enabled()) return;
    try {
      for (var object : repository.expiredUploads()) repository.expire(object.owner(),object.id());
      String key = repository.claimAudit();
      if (key != null) storage.delete(key);
    } catch (RuntimeException failure) { log.warn("Material maintenance incomplete (type={})",failure.getClass().getSimpleName()); }
  }
}
