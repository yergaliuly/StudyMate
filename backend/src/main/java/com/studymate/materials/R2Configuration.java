package com.studymate.materials;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

@Configuration(proxyBeanMethods = false)
class R2Configuration {
  @Bean
  @ConditionalOnProperty(name = "studymate.r2.enabled", havingValue = "true")
  MaterialTextHandler materialTextHandler(MaterialTextRepository repository, ObjectStorage storage,
      com.studymate.materials.pdf.PdfProcess parser) {
    return new MaterialTextHandler(repository, storage, parser);
  }
  @Bean
  @ConditionalOnProperty(name = "studymate.r2.enabled", havingValue = "true")
  MaterialCleanupHandler materialCleanupHandler(MaterialRepository repository, ObjectStorage storage) {
    return new MaterialCleanupHandler(repository, storage);
  }
  @Bean(destroyMethod = "close")
  @ConditionalOnProperty(name = "studymate.r2.enabled", havingValue = "true")
  R2ObjectStorage r2Storage(Environment env) {
    String endpoint = env.getProperty("studymate.r2.endpoint", "");
    // Production accepts only the authenticated R2 API, never an arbitrary/public endpoint.
    if (!endpoint.matches("https://[a-f0-9]{32}(?:\\.(?:eu|fedramp))?\\.r2\\.cloudflarestorage\\.com")) {
      throw new IllegalStateException("Set a valid HTTPS R2 account endpoint");
    }
    String bucket = env.getProperty("studymate.r2.bucket", "");
    if (!bucket.matches("[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")) throw new IllegalStateException("Set the private R2 bucket");
    String access = env.getProperty("studymate.r2.access-key-id", "");
    String secret = env.getProperty("studymate.r2.secret-access-key", "");
    if (access.isBlank() || secret.isBlank()) throw new IllegalStateException("Set R2 credentials in the environment");
    return new R2ObjectStorage(endpoint, bucket, access, secret);
  }

  @Bean
  @ConditionalOnProperty(name = "studymate.r2.enabled", havingValue = "false", matchIfMissing = true)
  ObjectStorage disabledStorage() {
    return new ObjectStorage() {
      public boolean enabled() { return false; }
      public void put(String key, long bytes, String sha, java.util.function.Supplier<java.io.InputStream> content) { throw new StorageFailure(); }
      public void delete(String key) { throw new StorageFailure(); }
      public Download download(String key) { throw new StorageFailure(); }
    };
  }
}
