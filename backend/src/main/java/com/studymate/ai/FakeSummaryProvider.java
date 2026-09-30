package com.studymate.ai;

import java.util.List;
import java.util.Set;

/** Local-only fixture; its model name makes test data unmistakable. */
final class FakeSummaryProvider implements SummaryProvider {
  public boolean available() { return true; }
  public String model() { return "fake-local"; }
  public Chunk summarize(String source, Set<Integer> allowedPages) {
    int page = allowedPages.iterator().next();
    return new Chunk(List.of(new Note("Демонстрационный конспект: реальный ИИ не вызывался.", List.of(page))), 0, 0);
  }
}
