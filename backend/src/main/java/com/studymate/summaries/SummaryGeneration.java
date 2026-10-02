package com.studymate.summaries;

import com.studymate.ai.AiFailure;
import com.studymate.ai.SummaryProvider;
import com.studymate.ai.SourceText;
import com.studymate.jobs.JobError;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Page-labelled, bounded calls. Every part of a long material is represented in the result. */
final class SummaryGeneration {
  private final SummaryProvider provider;
  SummaryGeneration(SummaryProvider provider) { this.provider = provider; }

  record SourcePage(int number, String text) {}
  record Result(String content, List<Integer> sourcePages, String model, int inputTokens, int outputTokens) {}
  private record InputChunk(String text, Set<Integer> pages) {}

  Result generate(List<SourcePage> pages) throws AiFailure, InterruptedException {
    if (pages.isEmpty() || pages.size() > 200) throw new AiFailure(JobError.AI_INVALID_RESPONSE);
    int chars = pages.stream().mapToInt(page -> page.text().length()).sum();
    if (chars < 1 || chars > 1_000_000) throw new AiFailure(JobError.AI_INVALID_RESPONSE);
    List<InputChunk> chunks = split(pages);
    if (chunks.isEmpty() || chunks.size() > 15) throw new AiFailure(JobError.AI_INVALID_RESPONSE);
    StringBuilder content = new StringBuilder();
    Set<Integer> sources = new LinkedHashSet<>();
    int inputTokens = 0, outputTokens = 0;
    for (InputChunk chunk : chunks) {
      if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
      SummaryProvider.Chunk result = provider.summarize(chunk.text(), chunk.pages());
      if (result.notes() == null || result.notes().isEmpty() || result.notes().size() > 8
          || result.inputTokens() < 0 || result.outputTokens() < 0) throw new AiFailure(JobError.AI_INVALID_RESPONSE);
      inputTokens = Math.addExact(inputTokens, result.inputTokens());
      outputTokens = Math.addExact(outputTokens, result.outputTokens());
      for (SummaryProvider.Note note : result.notes()) {
        if (note.text() == null || note.pageNumbers() == null || note.pageNumbers().isEmpty()
            || note.pageNumbers().size() > 8) throw new AiFailure(JobError.AI_INVALID_RESPONSE);
        String text = note.text().strip().replaceAll("\\s+", " ");
        if (text.length() < 5 || text.length() > 500 || note.pageNumbers().stream().anyMatch(n -> !chunk.pages().contains(n)))
          throw new AiFailure(JobError.AI_INVALID_RESPONSE);
        content.append("- ").append(text).append(" (стр. ");
        for (int i = 0; i < note.pageNumbers().size(); i++) {
          if (i > 0) content.append(", ");
          content.append(note.pageNumbers().get(i));
          sources.add(note.pageNumbers().get(i));
        }
        content.append(")\n");
      }
      if (content.length() > 100_000) throw new AiFailure(JobError.AI_INVALID_RESPONSE);
    }
    return new Result(content.toString().strip(), sources.stream().sorted().toList(), provider.model(), inputTokens, outputTokens);
  }

  private static List<InputChunk> split(List<SourcePage> pages) throws AiFailure {
    return SourceText.split(pages.stream().map(p -> new SourceText.Page(p.number(), p.text())).toList()).stream()
        .map(c -> new InputChunk(c.text(), c.pages())).toList();
  }
}
