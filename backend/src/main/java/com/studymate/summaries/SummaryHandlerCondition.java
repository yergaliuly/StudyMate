package com.studymate.summaries;

import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.core.type.AnnotatedTypeMetadata;

/** Disabled AI leaves already queued paid jobs untouched until the provider is configured again. */
final class SummaryHandlerCondition implements Condition {
  public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
    String provider = context.getEnvironment().getProperty("studymate.ai.provider", "disabled");
    if ("fake".equals(provider)) return true;
    if (!"openai".equals(provider)) return false;
    String key = System.getenv("STUDYMATE_OPENAI_API_KEY");
    return key != null && !key.isBlank();
  }
}
