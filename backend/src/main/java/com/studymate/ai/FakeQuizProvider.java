package com.studymate.ai;

import java.util.List;
import java.util.Set;
import java.util.stream.IntStream;

final class FakeQuizProvider implements QuizProvider {
  public boolean available() { return true; }
  public String model() { return "fake-local"; }
  public Result generate(String source, Set<Integer> allowedPages) {
    return new Result(IntStream.rangeClosed(1, 10).mapToObj(n -> new Question(
        "Демонстрационный вопрос " + n + ": чему равно " + n + " + 1?",
        List.of("" + (n + 1), "" + (n + 2), "" + (n + 3), "" + (n + 4)), 0,
        "Тестовая заглушка: реальный ИИ не вызывался.", List.of(allowedPages.iterator().next()))).toList(), 0, 0);
  }
}
