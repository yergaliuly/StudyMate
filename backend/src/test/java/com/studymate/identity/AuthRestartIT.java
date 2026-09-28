package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.UUID;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

/** Starts the packaged application in two separate JVMs against the dedicated test database. */
class AuthRestartIT {
  @Test
  void authenticatedSessionAndCsrfSurviveProcessRestartAndLogoutStaysEffective() throws Exception {
    String cookie;
    String token;
    String id;
    String subjectBody;
    String subjectLocation;
    var subjectInput = Map.of("title", "Persistent subject", "icon", "book", "tone", "blue");
    var keyHeader = Map.of("Idempotency-Key", UUID.randomUUID().toString());
    String email = "restart-" + UUID.randomUUID() + "@example.com";
    try (var first = start(); var browser = new AuthHttpClient(first.port())) {
      id = browser.register(email);
      browser.data(browser.login(email), 200);
      browser.csrf();
      cookie = browser.cookie;
      token = browser.token;
      var created = browser.send("POST", "/subjects", subjectInput, token, keyHeader);
      browser.data(created, 201);
      subjectBody = created.body();
      subjectLocation = created.headers().firstValue("Location").orElseThrow();
    }
    try (var second = start(); var browser = new AuthHttpClient(second.port())) {
      browser.cookie = cookie;
      browser.token = token;
      assertThat(browser.data(browser.send("GET", "/auth/me", null, null), 200).get("id").asString()).isEqualTo(id);
      var replay = browser.send("POST", "/subjects", subjectInput, token, keyHeader);
      browser.data(replay, 201);
      assertThat(replay.body()).isEqualTo(subjectBody);
      assertThat(replay.headers().firstValue("Location")).hasValue(subjectLocation);
      assertThat(browser.send("POST", "/auth/logout", null, token).statusCode()).isEqualTo(204);
    }
    try (var third = start(); var browser = new AuthHttpClient(third.port())) {
      browser.cookie = cookie;
      assertThat(browser.error(browser.send("GET", "/auth/me", null, null), 401)).isEqualTo("AUTHENTICATION_REQUIRED");
      assertThat(browser.error(browser.send("POST", "/auth/logout", null, token), 403)).isEqualTo("CSRF_INVALID");
      browser.csrf();
      assertThat(browser.data(browser.login(email), 200).get("id").asString()).isEqualTo(id);
      assertThat(browser.data(browser.send("GET", "/subjects", null, null), 200).size()).isEqualTo(1);
    }
  }

  private static RunningApp start() throws Exception {
    int port;
    try (var socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) { port = socket.getLocalPort(); }
    Path log = Files.createTempFile(Path.of("target"), "auth-restart-", ".log");
    String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
    var builder = new ProcessBuilder(java, "-jar", "target/studymate-backend-0.1.0-SNAPSHOT.jar",
        "--server.address=127.0.0.1", "--server.port=" + port, "--spring.profiles.active=local",
        "--studymate.registration.enabled=true").redirectErrorStream(true).redirectOutput(log.toFile());
    for (String suffix : new String[]{"URL", "USERNAME", "PASSWORD"}) {
      String value = System.getenv("STUDYMATE_TEST_DATABASE_" + suffix);
      if (value == null || value.isBlank()) throw new IllegalStateException("Missing dedicated test database setting: " + suffix);
      builder.environment().put("STUDYMATE_DATABASE_" + suffix, value);
    }
    var app = new RunningApp(builder.start(), port);
    try (var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build()) {
      long deadline = System.nanoTime() + Duration.ofSeconds(40).toNanos();
      while (System.nanoTime() < deadline && app.process().isAlive()) {
        try {
          var response = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/actuator/health"))
              .timeout(Duration.ofSeconds(2)).GET().build(), HttpResponse.BodyHandlers.discarding());
          if (response.statusCode() == 200) return app;
        } catch (java.io.IOException ignored) { /* Process is still starting. */ }
        Thread.sleep(100);
      }
      throw new IllegalStateException("Packaged backend did not become ready; see " + log);
    } catch (Exception exception) {
      app.close();
      throw exception;
    }
  }

  private record RunningApp(Process process, int port) implements AutoCloseable {
    @Override public void close() throws Exception {
      process.destroy();
      if (!process.waitFor(10, TimeUnit.SECONDS)) {
        process.destroyForcibly();
        if (!process.waitFor(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test application failed to stop");
      }
    }
  }
}
