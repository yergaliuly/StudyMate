package com.studymate.quizzes;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import com.studymate.ai.*;
import com.studymate.jobs.JobError;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class QuizGenerationTest {
  private final QuizProvider provider = mock(QuizProvider.class);
  private final SummaryProvider notes = mock(SummaryProvider.class);
  private final QuizGeneration generation = new QuizGeneration(provider, notes);

  private void valid() throws Exception {
    when(provider.model()).thenReturn("fixture-model");
    when(provider.generate(anyString(), anySet())).thenReturn(QuizFixtures.result());
  }

  @Test void smallDocumentUsesOneCallAndNoSavedSummary() throws Exception {
    valid();
    var result = generation.generate(List.of(new SourceText.Page(1, "Прямой текст лекции")));
    assertThat(result.questions()).hasSize(10);
    assertThat(result.inputTokens()).isEqualTo(70);
    verify(provider).generate(contains("Прямой текст лекции"), eq(Set.of(1)));
    verifyNoInteractions(notes);
  }

  @Test void maximumDocumentUsesAllPagesAndCountsEveryCall() throws Exception {
    valid();
    var seen = new ArrayList<String>();
    when(notes.summarize(anyString(), anySet())).thenAnswer(call -> {
      seen.add(call.getArgument(0)); Set<Integer> refs = call.getArgument(1);
      return new SummaryProvider.Chunk(List.of(new SummaryProvider.Note("Тезис по фрагменту", List.of(refs.stream().min(Integer::compareTo).orElseThrow()))), 10, 5);
    });
    var pages = IntStream.rangeClosed(1, 200).mapToObj(n -> new SourceText.Page(n, "х".repeat(5000))).toList();
    var result = generation.generate(pages);
    assertThat(seen.size()).isBetween(2, 15);
    assertThat(seen).allMatch(s -> s.length() <= 100_000);
    assertThat(String.join("", seen).chars().filter(c -> c == 'х').count()).isEqualTo(1_000_000);
    assertThat(String.join("", seen)).contains("Страница 1:", "Страница 200:");
    assertThat(result.inputTokens()).isEqualTo(seen.size() * 10 + 70);
    assertThat(result.outputTokens()).isEqualTo(seen.size() * 5 + 30);
    verify(provider).generate(anyString(), anySet());
  }

  @ParameterizedTest
  @ValueSource(strings = {"count", "duplicate-question", "options", "duplicate-option", "index", "reference", "repeated-reference",
      "empty-explanation", "long-text", "unicode", "control", "usage", "null-question"})
  void rejectsInvalidProviderResult(String scenario) throws Exception {
    valid();
    var questions = new ArrayList<>(QuizFixtures.result().questions());
    var q = questions.getFirst();
    questions.set(0, switch (scenario) {
      case "duplicate-question" -> questions.get(1);
      case "options" -> new QuizProvider.Question(q.text(), List.of("A", "B"), 0, q.explanation(), q.sourcePages());
      case "duplicate-option" -> new QuizProvider.Question(q.text(), List.of("A", " a ", "C", "D"), 0, q.explanation(), q.sourcePages());
      case "index" -> new QuizProvider.Question(q.text(), q.options(), 4, q.explanation(), q.sourcePages());
      case "reference" -> new QuizProvider.Question(q.text(), q.options(), 0, q.explanation(), List.of(2));
      case "repeated-reference" -> new QuizProvider.Question(q.text(), q.options(), 0, q.explanation(), List.of(1, 1));
      case "empty-explanation" -> new QuizProvider.Question(q.text(), q.options(), 0, " ", q.sourcePages());
      case "long-text" -> new QuizProvider.Question("x".repeat(1001), q.options(), 0, q.explanation(), q.sourcePages());
      case "unicode" -> new QuizProvider.Question("broken\uD800", q.options(), 0, q.explanation(), q.sourcePages());
      case "control" -> new QuizProvider.Question("NUL\0", q.options(), 0, q.explanation(), q.sourcePages());
      case "null-question" -> null;
      default -> q;
    });
    if (scenario.equals("count")) questions.removeLast();
    when(provider.generate(anyString(), anySet())).thenReturn(new QuizProvider.Result(questions, scenario.equals("usage") ? -1 : 1, 1));
    assertThatThrownBy(() -> generation.generate(List.of(new SourceText.Page(1, "Текст"))))
        .isInstanceOfSatisfying(AiFailure.class, e -> assertThat(e.code()).isEqualTo(JobError.AI_INVALID_RESPONSE));
  }

  @Test void interruptionStopsBeforeAnotherPaidCall() throws Exception {
    valid();
    Thread.currentThread().interrupt();
    try { assertThatThrownBy(() -> generation.generate(List.of(new SourceText.Page(1, "Текст")))).isInstanceOf(InterruptedException.class); }
    finally { Thread.interrupted(); }
    verify(provider, never()).generate(anyString(), anySet());
  }

  @Test void invalidChunkCannotReachFinalGeneration() throws Exception {
    valid();
    when(notes.summarize(anyString(), anySet())).thenReturn(new SummaryProvider.Chunk(
        List.of(new SummaryProvider.Note("Выдуманная ссылка", List.of(200))), 1, 1));
    assertThatThrownBy(() -> generation.generate(List.of(new SourceText.Page(1, "а".repeat(100_000)), new SourceText.Page(2, "б".repeat(50_000)))))
        .isInstanceOf(AiFailure.class);
    verify(provider, never()).generate(anyString(), anySet());
  }

  @Test void splitPreservesSurrogatesAndRejectsSourceBeyondLimits() throws Exception {
    String text = "а".repeat(79_999) + "😀" + "конец";
    var chunks = SourceText.split(List.of(new SourceText.Page(1, text)));
    assertThat(String.join("", chunks.stream().map(SourceText.Chunk::text).toList())).contains("😀конец");
    assertThatThrownBy(() -> SourceText.split(List.of(new SourceText.Page(1, "x".repeat(100_001))))).isInstanceOf(AiFailure.class);
    assertThatThrownBy(() -> SourceText.split(List.of(new SourceText.Page(1, "A"), new SourceText.Page(1, "B")))).isInstanceOf(AiFailure.class);
    assertThatThrownBy(() -> SourceText.split(IntStream.rangeClosed(1, 200)
        .mapToObj(n -> new SourceText.Page(n, "x".repeat(5001))).toList())).isInstanceOf(AiFailure.class);
  }

  @ParameterizedTest
  @ValueSource(ints = {10, 20, 200})
  void anySupportedPageDistributionFitsTheCallBudget(int pageCount) throws Exception {
    var pages = IntStream.rangeClosed(1, pageCount)
        .mapToObj(n -> new SourceText.Page(n, "я".repeat(1_000_000 / pageCount))).toList();
    var chunks = SourceText.split(pages);
    assertThat(chunks.size()).isLessThanOrEqualTo(15);
    assertThat(chunks).allMatch(c -> c.text().length() <= 100_000);
    assertThat(chunks.stream().mapToLong(c -> c.text().chars().filter(ch -> ch == 'я').count()).sum()).isEqualTo(1_000_000);
  }
}
