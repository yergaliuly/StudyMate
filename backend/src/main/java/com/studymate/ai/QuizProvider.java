package com.studymate.ai;

import java.util.List;
import java.util.Set;

/** Private generated content, never an HTTP response DTO. correctIndex is zero-based. */
public interface QuizProvider {
  boolean available();
  String model();
  Result generate(String source, Set<Integer> allowedPages) throws AiFailure, InterruptedException;
  record Question(String text, List<String> options, int correctIndex, String explanation, List<Integer> sourcePages) {}
  record Result(List<Question> questions, int inputTokens, int outputTokens) {}
}
