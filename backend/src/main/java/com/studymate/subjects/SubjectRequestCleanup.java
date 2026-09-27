package com.studymate.subjects;

import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

@Configuration(proxyBeanMethods = false)
@EnableScheduling
class SubjectRequestCleanup {
  private static final Logger log = LoggerFactory.getLogger(SubjectRequestCleanup.class);
  private final SubjectCreationRequests requests;
  SubjectRequestCleanup(SubjectCreationRequests requests) { this.requests = requests; }

  @Scheduled(initialDelay = 15, fixedDelay = 15, timeUnit = TimeUnit.MINUTES)
  void cleanExpiredResponses() {
    try { requests.deleteExpired(); }
    catch (DataAccessException exception) { log.warn("Idempotency cleanup failed (type={})", exception.getClass().getSimpleName()); }
  }
}
