package com.studymate.materials;

import java.io.InputStream;
import java.time.Instant;
import java.util.function.Supplier;

/** Private originals only. Implementations must bound calls and never log keys or credentials. */
public interface ObjectStorage {
  boolean enabled();
  void put(String key, long bytes, String sha256, Supplier<InputStream> content);
  void delete(String key);
  Download download(String key);
  record Download(String url, Instant expiresAt) {
    @Override public String toString() { return "Download[redacted]"; }
  }
}
