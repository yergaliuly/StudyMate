package com.studymate.ai;

import static org.assertj.core.api.Assertions.*;
import com.studymate.jobs.JobError;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class OpenAiSummaryClientTest {
  @Test void sendsStatelessStructuredRequestAndChecksReferences() throws Exception {
    var mapper = JsonMapper.builder().build();
    var captured = new AtomicReference<String>();
    var server = server(200, mapper.writeValueAsString(Map.of(
        "status", "completed", "output", List.of(Map.of("content", List.of(Map.of(
            "type", "output_text", "text", "{\"items\":[{\"text\":\"Проверенный тезис\",\"pageNumbers\":[2]}]}")))),
        "usage", Map.of("input_tokens", 42, "output_tokens", 17))), captured, new AtomicInteger());
    try {
      var client = new OpenAiSummaryClient(mapper, endpoint(server), () -> "test-only-key");
      var result = client.summarize("Страница 2:\nТестовый текст", Set.of(2));
      assertThat(result.notes().getFirst().pageNumbers()).containsExactly(2);
      assertThat(result.inputTokens()).isEqualTo(42);
      var request = mapper.readTree(captured.get());
      assertThat(request.path("store").asBoolean()).isFalse();
      assertThat(request.path("model").asString()).isEqualTo("gpt-6-luna");
      assertThat(request.at("/text/format/strict").asBoolean()).isTrue();
    } finally { server.stop(0); }
  }

  @Test void definiteHttpRejectionDoesNotRetry() throws Exception {
    var calls = new AtomicInteger();
    var server = server(429, "{}", new AtomicReference<>(), calls);
    try {
      var client = new OpenAiSummaryClient(JsonMapper.builder().build(), endpoint(server), () -> "test-only-key");
      assertThatThrownBy(() -> client.summarize("Страница 1:\nТекст", Set.of(1)))
          .isInstanceOfSatisfying(AiFailure.class, failure -> assertThat(failure.code()).isEqualTo(JobError.AI_UNAVAILABLE));
      assertThat(calls).hasValue(1);
    } finally { server.stop(0); }
  }

  private static URI endpoint(HttpServer server) { return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/v1/responses"); }
  private static HttpServer server(int status, String body, AtomicReference<String> captured, AtomicInteger calls) throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/v1/responses", exchange -> {
      calls.incrementAndGet();
      captured.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
      byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
      exchange.sendResponseHeaders(status, bytes.length);
      try (var output = exchange.getResponseBody()) { output.write(bytes); }
    });
    server.start();
    return server;
  }
}
