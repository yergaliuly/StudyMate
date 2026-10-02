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
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.json.JsonMapper;

class OpenAiQuizClientTest {
  private final JsonMapper json = JsonMapper.builder().build();
  @Test void sendsStructuredStatelessRequestAndParsesPrivateAnswer() throws Exception {
    var captured = new AtomicReference<String>();
    var count = new AtomicInteger();
    var server = server(200, envelope(Map.of("sufficient", true, "questions", QuizFixtures.result().questions())), captured, count);
    try {
      var response = client(server).generate("Страница 1:\nТекст", Set.of(1));
      assertThat(response.questions()).hasSize(10);
      assertThat(response.questions().getFirst().correctIndex()).isEqualTo(1);
      var request = json.readTree(captured.get());
      assertThat(request.path("store").asBoolean()).isFalse();
      assertThat(request.at("/text/format/strict").asBoolean()).isTrue();
      assertThat(request.at("/text/format/schema/properties/questions/items/properties/options/minItems").asInt()).isEqualTo(4);
      assertThat(request.path("model").asString()).isEqualTo("gpt-6-luna");
      assertThat(count).hasValue(1);
    } finally { server.stop(0); }
  }
  @ParameterizedTest
  @ValueSource(strings = {"insufficient", "incomplete", "refusal", "wrong-index-type", "invented-page", "bad-json", "http-rejection", "usage"})
  void failsWithoutRetryAndDoesNotRetainRawResponse(String scenario) throws Exception {
    var body = json.valueToTree(Map.of("sufficient", true, "questions", QuizFixtures.result().questions())).deepCopy();
    if (scenario.equals("wrong-index-type")) ((tools.jackson.databind.node.ObjectNode)body.path("questions").get(0)).put("correctIndex", "1");
    if (scenario.equals("invented-page")) ((tools.jackson.databind.node.ObjectNode)body.path("questions").get(0)).set("sourcePages", json.valueToTree(List.of(200)));
    String raw = envelope(body);
    if (scenario.equals("insufficient")) raw = envelope(Map.of("sufficient", false, "questions", List.of()));
    if (scenario.equals("incomplete")) raw = raw.replace("completed", "incomplete");
    if (scenario.equals("refusal")) raw = raw.replace("output_text", "refusal");
    if (scenario.equals("bad-json")) raw = "private invalid provider response";
    if (scenario.equals("usage")) raw = raw.replace("\"input_tokens\":50", "\"input_tokens\":\"50\"");
    var count = new AtomicInteger();
    var server = server(scenario.equals("http-rejection") ? 429 : 200, raw, new AtomicReference<>(), count);
    try {
      JobError expected = scenario.equals("insufficient") ? JobError.QUIZ_INSUFFICIENT_CONTENT
          : scenario.equals("http-rejection") ? JobError.AI_UNAVAILABLE : JobError.AI_INVALID_RESPONSE;
      assertThatThrownBy(() -> client(server).generate("Страница 1:\nТекст", Set.of(1)))
          .isInstanceOfSatisfying(AiFailure.class, e -> {
            assertThat(e.code()).isEqualTo(expected); assertThat(e.getCause()).isNull();
            assertThat(e.getMessage()).isEqualTo(expected.name());
          });
      assertThat(count).hasValue(1);
    } finally { server.stop(0); }
  }
  private String envelope(Object result) {
    return json.writeValueAsString(Map.of("status", "completed", "output", List.of(Map.of("content", List.of(
        Map.of("type", "output_text", "text", json.writeValueAsString(result))))), "usage", Map.of("input_tokens", 50, "output_tokens", 100)));
  }
  private OpenAiQuizClient client(HttpServer server) {
    return new OpenAiQuizClient(json, URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/v1/responses"), () -> "test-only-key");
  }
  private HttpServer server(int status, String body, AtomicReference<String> captured, AtomicInteger calls) throws Exception {
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/v1/responses", exchange -> {
      calls.incrementAndGet(); captured.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
      byte[] bytes = body.getBytes(StandardCharsets.UTF_8); exchange.sendResponseHeaders(status, bytes.length);
      try (var stream = exchange.getResponseBody()) { stream.write(bytes); }
    });
    server.start(); return server;
  }
}
