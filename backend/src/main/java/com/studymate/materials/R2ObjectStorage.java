package com.studymate.materials;

import java.io.InputStream;
import java.net.URI;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.function.Supplier;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.retries.StandardRetryStrategy;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;

final class R2ObjectStorage implements ObjectStorage, AutoCloseable {
  private final S3Client client;
  private final S3Presigner signer;
  private final String bucket;

  // Package access permits an explicitly local S3 protocol stub in tests, never via production config.
  R2ObjectStorage(String endpoint, String bucket, String access, String secret) {
    this.bucket = bucket;
    var credentials = StaticCredentialsProvider.create(AwsBasicCredentials.create(access, secret));
    var config = S3Configuration.builder().pathStyleAccessEnabled(true).chunkedEncodingEnabled(false).build();
    client = S3Client.builder().region(Region.of("auto")).endpointOverride(URI.create(endpoint))
        .credentialsProvider(credentials).serviceConfiguration(config)
        .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
        .httpClientBuilder(UrlConnectionHttpClient.builder().connectionTimeout(Duration.ofSeconds(5))
            .socketTimeout(Duration.ofSeconds(20)))
        .overrideConfiguration(c -> c.apiCallTimeout(Duration.ofSeconds(60)).apiCallAttemptTimeout(Duration.ofSeconds(30))
            .retryStrategy(StandardRetryStrategy.builder().maxAttempts(1).build())).build();
    signer = S3Presigner.builder().region(Region.of("auto")).endpointOverride(URI.create(endpoint))
        .credentialsProvider(credentials).serviceConfiguration(config).build();
  }

  public boolean enabled() { return true; }

  public void put(String key, long bytes, String sha, Supplier<InputStream> content) {
    try {
      // Content-MD5 is supported by R2 for a single PutObject. SHA-256 remains the application fingerprint.
      var md5 = java.security.MessageDigest.getInstance("MD5");
      try (var stream = content.get()) {
        byte[] buffer = new byte[8192]; int read;
        while ((read = stream.read(buffer)) != -1) md5.update(buffer,0,read);
      }
      String checksum = Base64.getEncoder().encodeToString(md5.digest());
      try (var body = content.get()) {
        client.putObject(r -> r.bucket(bucket).key(key).contentType("application/pdf").contentLength(bytes)
              .contentDisposition("attachment; filename=\"material.pdf\"").cacheControl("private, no-store")
              .contentMD5(checksum)
              .metadata(Map.of("sha256", sha)),
            RequestBody.fromInputStream(body, bytes));
      }
    } catch (Exception failure) { throw new StorageFailure(); }
  }

  public void delete(String key) {
    try { client.deleteObject(r -> r.bucket(bucket).key(key)); }
    catch (RuntimeException failure) { throw new StorageFailure(); }
  }

  public Download download(String key) {
    try {
      var result = signer.presignGetObject(r -> r.signatureDuration(Duration.ofSeconds(60))
          .getObjectRequest(g -> g.bucket(bucket).key(key).responseContentType("application/pdf")
              .responseContentDisposition("attachment; filename=\"material.pdf\"")
              .responseCacheControl("private, no-store")));
      return new Download(result.url().toString(), result.expiration());
    } catch (RuntimeException failure) { throw new StorageFailure(); }
  }

  public void close() { signer.close(); client.close(); }
}
