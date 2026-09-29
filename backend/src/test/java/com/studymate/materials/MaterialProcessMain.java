package com.studymate.materials;

import com.studymate.StudyMateApplication;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** Test-classpath-only: the production configuration never accepts this local endpoint or test credentials. */
public final class MaterialProcessMain {
  public static void main(String[] args) { SpringApplication.run(new Class<?>[]{StudyMateApplication.class, Adapter.class},args); }
  @TestConfiguration(proxyBeanMethods=false)
  static class Adapter {
    @Bean @Primary R2ObjectStorage localProtocolStorage(@Value("${test.storage.endpoint}") String endpoint) {
      return new R2ObjectStorage(endpoint,"private-bucket","test-only-key","test-only-secret");
    }
    @Bean MaterialCleanupHandler realCleanupHandler(MaterialRepository repository,ObjectStorage storage) {
      return new MaterialCleanupHandler(repository,storage);
    }
  }
}
