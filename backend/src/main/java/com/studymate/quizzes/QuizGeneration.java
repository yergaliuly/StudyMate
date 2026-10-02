package com.studymate.quizzes;

import com.studymate.ai.AiFailure;
import com.studymate.ai.QuizProvider;
import com.studymate.ai.SourceText;
import com.studymate.ai.SummaryProvider;
import com.studymate.jobs.JobError;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Long sources are distilled in full, then one final request creates ten questions. */
final class QuizGeneration {
  private final QuizProvider provider;
  private final SummaryProvider notes;
  QuizGeneration(QuizProvider provider, SummaryProvider notes) { this.provider = provider; this.notes = notes; }
  record Result(List<QuizProvider.Question> questions, String model, int inputTokens, int outputTokens) {}

  Result generate(List<SourceText.Page> pages) throws AiFailure, InterruptedException {
    try {
      List<SourceText.Chunk> chunks = SourceText.split(pages);
      String source;
      Set<Integer> allowedPages = new HashSet<>();
      int inputTokens = 0, outputTokens = 0;
      if (chunks.size() == 1) {
        source = chunks.getFirst().text(); allowedPages.addAll(chunks.getFirst().pages());
      } else {
        StringBuilder context = new StringBuilder();
        for (var chunk : chunks) {
          interrupted();
          var result = notes.summarize(chunk.text(), chunk.pages());
          if (result == null || result.notes() == null || result.notes().isEmpty() || result.notes().size() > 8) throw invalid();
          inputTokens = tokens(inputTokens, result.inputTokens()); outputTokens = tokens(outputTokens, result.outputTokens());
          for (var note : result.notes()) {
            if (note == null) throw invalid();
            String text = text(note.text(), 500);
            List<Integer> refs = references(note.pageNumbers(), chunk.pages());
            allowedPages.addAll(refs);
            context.append("Страницы ").append(refs).append(": ").append(text).append('\n');
          }
        }
        source = context.toString();
      }
      if (source.isBlank() || source.length() > 100_000) throw invalid();
      interrupted();
      var result = provider.generate(source, Set.copyOf(allowedPages));
      if (result == null || result.questions() == null || result.questions().size() != 10) throw invalid();
      List<QuizProvider.Question> validated = new ArrayList<>();
      Set<String> prompts = new HashSet<>();
      for (var q : result.questions()) {
        if (q == null || q.options() == null || q.options().size() != 4 || q.correctIndex() < 0 || q.correctIndex() > 3) throw invalid();
        String prompt = text(q.text(), 1000);
        if (!prompts.add(key(prompt))) throw invalid();
        List<String> options = new ArrayList<>();
        Set<String> distinct = new HashSet<>();
        for (String option : q.options()) {
          String value = text(option, 500);
          if (!distinct.add(key(value))) throw invalid();
          options.add(value);
        }
        validated.add(new QuizProvider.Question(prompt, List.copyOf(options), q.correctIndex(),
            text(q.explanation(), 2000), references(q.sourcePages(), allowedPages)));
      }
      return new Result(List.copyOf(validated), text(provider.model(), 80),
          tokens(inputTokens, result.inputTokens()), tokens(outputTokens, result.outputTokens()));
    } catch (ArithmeticException failure) { throw invalid(); }
  }

  private static int tokens(int total, int value) throws AiFailure {
    if (value < 0) throw invalid();
    return Math.addExact(total, value);
  }
  private static List<Integer> references(List<Integer> refs, Set<Integer> allowed) throws AiFailure {
    if (refs == null || refs.isEmpty() || refs.size() > 8 || new HashSet<>(refs).size() != refs.size()
        || refs.stream().anyMatch(n -> n == null || !allowed.contains(n))) throw invalid();
    return refs.stream().sorted().toList();
  }
  private static String text(String value, int max) throws AiFailure {
    if (value == null || value.length() > max) throw invalid();
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (Character.isHighSurrogate(c)) {
        if (++i == value.length() || !Character.isLowSurrogate(value.charAt(i))) throw invalid();
      } else if (Character.isLowSurrogate(c) || Character.isISOControl(c) && c != '\n' && c != '\r' && c != '\t') throw invalid();
    }
    String normalized = value.replaceAll("(?U)\\s+", " ").strip();
    if (normalized.isBlank()) throw invalid();
    return normalized;
  }
  private static String key(String value) { return Normalizer.normalize(value, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT); }
  private static void interrupted() throws InterruptedException { if (Thread.currentThread().isInterrupted()) throw new InterruptedException(); }
  private static AiFailure invalid() { return new AiFailure(JobError.AI_INVALID_RESPONSE); }
}
