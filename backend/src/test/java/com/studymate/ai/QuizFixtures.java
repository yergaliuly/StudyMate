package com.studymate.ai;

import java.util.List;
import java.util.stream.IntStream;

public final class QuizFixtures {
  private QuizFixtures() {}
  public static QuizProvider.Result result() {
    return new QuizProvider.Result(IntStream.rangeClosed(1, 10).mapToObj(n -> new QuizProvider.Question(
        "Вопрос по материалу номер " + n, List.of("Первый " + n, "Второй " + n, "Третий " + n, "Четвёртый " + n),
        n % 4, "Секретное объяснение номер " + n, List.of(1))).toList(), 70, 30);
  }
}
