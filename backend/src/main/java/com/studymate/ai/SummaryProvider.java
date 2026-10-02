package com.studymate.ai;

import java.util.List;
import java.util.Set;

/** A single bounded request. The domain layer splits a material before calling a provider. */
public interface SummaryProvider {
  boolean available();
  String model();
  Chunk summarize(String source, Set<Integer> allowedPages) throws AiFailure, InterruptedException;

  record Note(String text, List<Integer> pageNumbers) {}
  record Chunk(List<Note> notes, int inputTokens, int outputTokens) {}
}
