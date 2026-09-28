package com.studymate.identity;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Real HTTP with a small in-memory cookie jar; never prints cookie/token/password values. */
public final class AuthHttpClient implements AutoCloseable {
  static final String PASSWORD = "  Integration-only password!  ";
  private static final JsonMapper JSON = JsonMapper.builder().build();
  private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
  private final int port;
  public String cookie;
  public String token;

  public AuthHttpClient(int port) { this.port = port; }

  public HttpResponse<String> send(String method, String path, Object body, String csrf) throws Exception {
    return send(method, path, body, csrf, Map.of());
  }

  public HttpResponse<String> send(String method, String path, Object body, String csrf,
      Map<String, String> headers) throws Exception {
    var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1" + path))
        .timeout(Duration.ofSeconds(10));
    if (cookie != null) builder.header("Cookie", cookie);
    if (csrf != null) builder.header("X-CSRF-TOKEN", csrf);
    if (body != null) builder.header("Content-Type", "application/json");
    headers.forEach(builder::header);
    builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
        : HttpRequest.BodyPublishers.ofString(body instanceof String raw ? raw : JSON.writeValueAsString(body)));
    var response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    for (var header : response.headers().allValues("Set-Cookie")) {
      if (header.startsWith("STUDYMATE_SESSION=")) {
        cookie = header.contains("Max-Age=0") ? null : header.split(";", 2)[0];
      }
    }
    assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
    if (!(path.equals("/subjects") && response.statusCode() == 201)) {
      assertThat(response.headers().firstValue("Location")).isEmpty();
    }
    return response;
  }

  public JsonNode data(HttpResponse<String> response, int status) {
    assertThat(response.statusCode()).isEqualTo(status);
    return JSON.readTree(response.body()).get("data");
  }

  public String error(HttpResponse<String> response, int status) {
    assertThat(response.statusCode()).isEqualTo(status);
    return JSON.readTree(response.body()).at("/error/code").asString();
  }

  public HttpResponse<String> csrf() throws Exception {
    var response = send("GET", "/auth/csrf", null, null);
    var data = data(response, 200);
    assertThat(data.get("headerName").asString()).isEqualTo("X-CSRF-TOKEN");
    assertThat(data.size()).isEqualTo(2);
    token = data.get("token").asString();
    assertThat(token.isBlank()).isFalse();
    return response;
  }

  public String register(String email) throws Exception {
    csrf();
    return data(send("POST", "/auth/register",
        Map.of("email", email, "password", PASSWORD, "displayName", "HTTP Test"), token), 201)
        .get("id").asString();
  }

  public HttpResponse<String> login(String email) throws Exception {
    return send("POST", "/auth/login", Map.of("email", email, "password", PASSWORD), token);
  }

  String sessionId() {
    return new String(Base64.getDecoder().decode(cookie.substring(cookie.indexOf('=') + 1)), StandardCharsets.UTF_8);
  }

  @Override public void close() { http.close(); }
}
