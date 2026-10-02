package com.studymate.ai;

import com.studymate.jobs.JobError;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.function.Supplier;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Shared stateless transport. No automatic retry and no request/response logging. */
final class OpenAiResponsesClient {
  static final URI ENDPOINT = URI.create("https://api.openai.com/v1/responses");
  static final String MODEL = "gpt-6-luna";
  private final JsonMapper json;
  private final URI endpoint;
  private final Supplier<String> keySupplier;
  private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  OpenAiResponsesClient(JsonMapper json, URI endpoint, Supplier<String> keySupplier) {
    this.json = json; this.endpoint = endpoint; this.keySupplier = keySupplier;
  }
  boolean available() { String key = keySupplier.get(); return key != null && !key.isBlank(); }
  record Result(JsonNode content, int inputTokens, int outputTokens) {}

  Result complete(String name, String instructions, String source, Map<String,Object> schema, int maxTokens)
      throws AiFailure, InterruptedException {
    String key = keySupplier.get();
    if (key == null || key.isBlank()) throw new AiFailure(JobError.AI_UNAVAILABLE);
    String body = json.writeValueAsString(Map.of(
        "model", MODEL, "reasoning", Map.of("effort", "none"), "store", false,
        "max_output_tokens", maxTokens, "instructions", instructions, "input", source,
        "text", Map.of("format", Map.of("type", "json_schema", "name", name, "strict", true, "schema", schema))));
    HttpRequest request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(65))
        .header("Authorization", "Bearer " + key).header("Content-Type", "application/json; charset=utf-8")
        .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8)).build();
    HttpResponse<String> response;
    try { response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)); }
    catch (IOException failure) { throw new AiFailure(JobError.AI_OUTCOME_UNKNOWN); }
    if (response.statusCode() != 200) throw new AiFailure(JobError.AI_UNAVAILABLE);
    try {
      if (response.body().length() > 1_000_000) throw new IllegalArgumentException();
      JsonNode envelope = json.readTree(response.body());
      if (!"completed".equals(envelope.path("status").asString())) throw new IllegalArgumentException();
      StringBuilder output = new StringBuilder();
      for (JsonNode item : envelope.path("output")) for (JsonNode part : item.path("content")) {
        if ("refusal".equals(part.path("type").asString())) throw new IllegalArgumentException();
        if ("output_text".equals(part.path("type").asString())) {
          if (!part.path("text").isString()) throw new IllegalArgumentException();
          output.append(part.path("text").asString());
        }
      }
      JsonNode input = envelope.path("usage").path("input_tokens"), tokens = envelope.path("usage").path("output_tokens");
      if (!input.isInt() || !tokens.isInt() || input.asInt() < 0 || tokens.asInt() < 0) throw new IllegalArgumentException();
      JsonNode content = json.readTree(output.toString());
      if (content == null || !content.isObject()) throw new IllegalArgumentException();
      return new Result(content, input.asInt(), tokens.asInt());
    } catch (RuntimeException failure) { throw new AiFailure(JobError.AI_INVALID_RESPONSE); }
  }
}
