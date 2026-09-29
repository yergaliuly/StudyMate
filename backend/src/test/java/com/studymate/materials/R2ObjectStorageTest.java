package com.studymate.materials;

import static org.assertj.core.api.Assertions.*;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class R2ObjectStorageTest {
  @Test void fetchChecksActualBytesHashAndStopsOversizedStream() throws Exception {
    byte[] pdf=MaterialInputTest.PDF;
    var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
    var calls=new AtomicInteger();
    server.createContext("/",exchange -> {
      calls.incrementAndGet(); exchange.sendResponseHeaders(200,pdf.length);
      exchange.getResponseBody().write(pdf); exchange.close();
    }); server.start();
    try(var storage=new R2ObjectStorage("http://127.0.0.1:"+server.getAddress().getPort(),"private-bucket","test-only-key","test-only-secret");
        var workspace=new com.studymate.materials.pdf.PdfWorkspace()) {
      String sha=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pdf));
      storage.fetch("originals/test.pdf",workspace.input(),pdf.length,sha);
      assertThat(java.nio.file.Files.readAllBytes(workspace.input())).isEqualTo(pdf);
      assertThatThrownBy(() -> storage.fetch("originals/test.pdf",workspace.directory().resolve("hash.pdf"),pdf.length,"0".repeat(64)))
          .isInstanceOf(ObjectIntegrityFailure.class).hasNoCause();
      assertThatThrownBy(() -> storage.fetch("originals/test.pdf",workspace.directory().resolve("short.pdf"),pdf.length+1,sha))
          .isInstanceOf(ObjectIntegrityFailure.class);
      assertThatThrownBy(() -> storage.fetch("originals/test.pdf",workspace.directory().resolve("large.pdf"),pdf.length-1,sha))
          .isInstanceOf(ObjectIntegrityFailure.class);
      assertThat(java.nio.file.Files.size(workspace.directory().resolve("large.pdf"))).isLessThan(pdf.length);
      assertThat(calls.get()).isEqualTo(4);
    } finally { server.stop(0); }
  }
  @Test void actualSdkUsesSignedNonChunkedPutChecksumPrivateDownloadAndIdempotentDelete() throws Exception {
    var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
    var calls=new AtomicInteger(); var failure=new AtomicReference<Throwable>();
    byte[] pdf=MaterialInputTest.PDF;
    String md5=Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(pdf));
    server.createContext("/",exchange -> {
      try {
        calls.incrementAndGet();
        assertThat(exchange.getRequestURI().getPath()).isEqualTo("/private-bucket/originals/test.pdf");
        assertThat(exchange.getRequestHeaders().getFirst("Authorization").startsWith("AWS4-HMAC-SHA256 ")).isTrue();
        if (exchange.getRequestMethod().equals("PUT")) {
          assertThat(exchange.getRequestHeaders().getFirst("Content-Length")).isEqualTo(Integer.toString(pdf.length));
          assertThat(exchange.getRequestHeaders().getFirst("Transfer-Encoding")).isNull();
          assertThat(exchange.getRequestHeaders().getFirst("Content-MD5")).isEqualTo(md5);
          assertThat(exchange.getRequestHeaders().getFirst("Content-Type")).isEqualTo("application/pdf");
          assertThat(exchange.getRequestHeaders().getFirst("x-amz-acl")).isNull();
          assertThat(exchange.getRequestBody().readAllBytes()).isEqualTo(pdf);
          exchange.getResponseHeaders().set("ETag","\"fixture\""); exchange.sendResponseHeaders(200,-1);
        } else { assertThat(exchange.getRequestMethod()).isEqualTo("DELETE"); exchange.sendResponseHeaders(204,-1); }
      } catch(Throwable error) { failure.set(error); exchange.sendResponseHeaders(500,-1); }
      finally { exchange.close(); }
    });
    server.start();
    try (var storage=new R2ObjectStorage("http://127.0.0.1:"+server.getAddress().getPort(),"private-bucket","test-only-key","test-only-secret");
        var workspace=new com.studymate.materials.pdf.PdfWorkspace()) {
      java.nio.file.Files.write(workspace.input(),pdf);
      var closed=new AtomicInteger(); var opened=new AtomicInteger();
      storage.put("originals/test.pdf",pdf.length,HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pdf)),() -> {
        try {
          var file=java.nio.file.Files.newInputStream(workspace.input());
          assertThat(file.markSupported()).isFalse(); opened.incrementAndGet();
          return new java.io.FilterInputStream(file) {
            private boolean done;
            @Override public void close() throws java.io.IOException { if(!done) { done=true; closed.incrementAndGet(); super.close(); } }
          };
        } catch(java.io.IOException error) { throw new java.io.UncheckedIOException(error); }
      });
      assertThat(opened.get()).isGreaterThanOrEqualTo(2); assertThat(closed.get()).isEqualTo(opened.get());
      var download=storage.download("originals/test.pdf");
      var query=URI.create(download.url()).getRawQuery();
      assertThat(query.contains("X-Amz-Expires=60") && query.contains("X-Amz-Signature=") && query.contains("response-content-disposition=")).isTrue();
      assertThat(Duration.between(Instant.now(),download.expiresAt()).toSeconds()).isBetween(55L,60L);
      assertThat(download.toString()).isEqualTo("Download[redacted]");
      storage.delete("originals/test.pdf"); storage.delete("originals/test.pdf");
      assertThat(calls.get()).isEqualTo(3); assertThat(failure.get()).isNull();
    } finally { server.stop(0); }
  }
  @Test void sdkFailuresAreRedactedAndPutHasNoImplicitRetries() throws Exception {
    var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0); var calls=new AtomicInteger();
    server.createContext("/",exchange -> {
      calls.incrementAndGet(); exchange.getRequestBody().readAllBytes();
      byte[] error="<Error><Code>InternalError</Code><Message>private-content</Message></Error>".getBytes(StandardCharsets.UTF_8);
      exchange.sendResponseHeaders(500,error.length); exchange.getResponseBody().write(error); exchange.close();
    }); server.start();
    try(var storage=new R2ObjectStorage("http://127.0.0.1:"+server.getAddress().getPort(),"private-bucket","test-only-key","test-only-secret")) {
      assertThatThrownBy(() -> storage.put("originals/test.pdf",1,"0".repeat(64),() -> new ByteArrayInputStream(new byte[]{1})))
          .isInstanceOf(StorageFailure.class).hasNoCause().hasMessage("Private storage unavailable");
      assertThat(calls.get()).isEqualTo(1);
    } finally { server.stop(0); }
  }
}
