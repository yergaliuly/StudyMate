package com.studymate.summaries;

import static org.assertj.core.api.Assertions.*;
import com.studymate.ai.AiFailure;
import com.studymate.ai.SummaryProvider;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

class SummaryGenerationTest {
  @Test void includesEveryChunkAndPhysicalPageWithoutTruncation() throws Exception {
    var seen = new ArrayList<String>();
    SummaryProvider provider = new SummaryProvider() {
      public boolean available() { return true; }
      public String model() { return "fixture"; }
      public Chunk summarize(String source, Set<Integer> pages) {
        seen.add(source);
        return new Chunk(List.of(new Note("Тезис из фрагмента", List.of(pages.iterator().next()))), 10, 5);
      }
    };
    String large = "а".repeat(100_000);
    var result = new SummaryGeneration(provider).generate(List.of(
        new SummaryGeneration.SourcePage(1, large), new SummaryGeneration.SourcePage(2, large)));
    assertThat(seen.size()).isGreaterThanOrEqualTo(3);
    assertThat(seen.stream().mapToInt(String::length).sum()).isGreaterThan(200_000);
    assertThat(seen).allMatch(chunk -> chunk.length() <= 100_000);
    assertThat(result.sourcePages()).containsExactly(1, 2);
    assertThat(result.inputTokens()).isEqualTo(seen.size() * 10);
    assertThat(result.content()).contains("стр. 1", "стр. 2");
  }

  @Test void rejectsInventedPageReferences() {
    SummaryProvider provider = new SummaryProvider() {
      public boolean available() { return true; }
      public String model() { return "fixture"; }
      public Chunk summarize(String source, Set<Integer> pages) {
        return new Chunk(List.of(new Note("Несуществующая ссылка", List.of(200))), 1, 1);
      }
    };
    assertThatThrownBy(() -> new SummaryGeneration(provider).generate(
        List.of(new SummaryGeneration.SourcePage(1, "Текст лекции"))))
        .isInstanceOf(AiFailure.class);
  }

  @Test void approvedMaximumOfTwoHundredPagesFitsTheBoundedPlan() throws Exception {
    var seen = new ArrayList<String>();
    SummaryProvider provider = new SummaryProvider() {
      public boolean available() { return true; }
      public String model() { return "fixture"; }
      public Chunk summarize(String source, Set<Integer> pages) {
        seen.add(source);
        return new Chunk(List.of(new Note("Тезис по фрагменту", List.of(pages.iterator().next()))), 1, 1);
      }
    };
    var pages = IntStream.rangeClosed(1, 200)
        .mapToObj(number -> new SummaryGeneration.SourcePage(number, "х".repeat(5_000))).toList();
    new SummaryGeneration(provider).generate(pages);
    assertThat(seen.size()).isBetween(1, 15);
    assertThat(String.join("", seen)).contains("Страница 1:", "Страница 200:");
    assertThat(seen.stream().mapToInt(String::length).sum()).isGreaterThan(1_000_000);
  }
}
