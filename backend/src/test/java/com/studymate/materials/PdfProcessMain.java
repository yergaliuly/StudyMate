package com.studymate.materials;

import com.studymate.StudyMateApplication;
import com.studymate.materials.pdf.PdfProcess;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.*;

/** Local S3 endpoint is available only on the test classpath. Real worker/SDK/parser/repositories. */
public final class PdfProcessMain {
  public static void main(String[] args) { SpringApplication.run(new Class<?>[]{StudyMateApplication.class,Adapter.class},args); }
  @TestConfiguration(proxyBeanMethods=false)
  static class Adapter {
    @Bean @Primary R2ObjectStorage localPdfStorage(@Value("${test.storage.endpoint}") String endpoint) {
      return new R2ObjectStorage(endpoint,"private-bucket","test-only-key","test-only-secret");
    }
    @Bean MaterialTextHandler realPdfHandler(MaterialTextRepository repository,ObjectStorage storage,PdfProcess parser) {
      return new MaterialTextHandler(repository,storage,parser);
    }
    @Bean MaterialCleanupHandler realPdfCleanup(MaterialRepository repository,ObjectStorage storage) {
      return new MaterialCleanupHandler(repository,storage);
    }
  }
}
