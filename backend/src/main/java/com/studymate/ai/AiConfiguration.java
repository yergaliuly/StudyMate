package com.studymate.ai;

import java.util.Arrays;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import tools.jackson.databind.json.JsonMapper;

@Configuration(proxyBeanMethods = false)
class AiConfiguration {
  @Bean
  QuizProvider quizProvider(@Value("${studymate.ai.provider:disabled}") String provider,
      Environment environment, JsonMapper json) {
    return switch (provider) {
      case "disabled" -> new DisabledQuizProvider();
      case "openai" -> new OpenAiQuizClient(json);
      case "fake" -> {
        if (Arrays.stream(environment.getActiveProfiles()).noneMatch("local"::equals))
          throw new IllegalStateException("Fake AI provider is permitted only in the local profile");
        yield new FakeQuizProvider();
      }
      default -> throw new IllegalArgumentException("Unknown AI provider");
    };
  }
  @Bean
  SummaryProvider summaryProvider(@Value("${studymate.ai.provider:disabled}") String provider,
      Environment environment, JsonMapper json) {
    return switch (provider) {
      case "disabled" -> new DisabledSummaryProvider();
      case "openai" -> new OpenAiSummaryClient(json);
      case "fake" -> {
        if (Arrays.stream(environment.getActiveProfiles()).noneMatch("local"::equals))
          throw new IllegalStateException("Fake AI provider is permitted only in the local profile");
        yield new FakeSummaryProvider();
      }
      default -> throw new IllegalArgumentException("Unknown AI provider");
    };
  }
}
