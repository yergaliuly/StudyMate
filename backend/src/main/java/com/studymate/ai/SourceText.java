package com.studymate.ai;

import com.studymate.jobs.JobError;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Shared bounded input plan; no part of an accepted PDF is silently discarded. */
public final class SourceText {
  private SourceText() {}
  public record Page(int number, String text) {}
  public record Chunk(String text, Set<Integer> pages) {}

  public static List<Chunk> split(List<Page> pages) throws AiFailure {
    if (pages == null || pages.isEmpty() || pages.size() > 200) throw invalid();
    long characters = 0;
    int previous = 0;
    List<Chunk> chunks = new ArrayList<>();
    StringBuilder current = new StringBuilder();
    Set<Integer> refs = new LinkedHashSet<>();
    for (Page page : pages) {
      if (page == null || page.number() <= previous || page.number() > 200 || page.text() == null
          || page.text().length() > 100_000) throw invalid();
      previous = page.number();
      characters += page.text().length();
      if (characters > 1_000_000) throw invalid();
      for (int offset = 0; offset < page.text().length();) {
        String header = "\nСтраница " + page.number() + ":\n";
        int capacity = 100_000 - current.length() - header.length();
        if (capacity < 2) {
          chunks.add(new Chunk(current.toString(), Set.copyOf(refs)));
          current.setLength(0); refs.clear(); continue;
        }
        int end = Math.min(page.text().length(), offset + capacity);
        if (end < page.text().length() && Character.isHighSurrogate(page.text().charAt(end - 1))) end--;
        current.append(header).append(page.text(), offset, end); refs.add(page.number()); offset = end;
      }
    }
    if (!current.isEmpty()) chunks.add(new Chunk(current.toString(), Set.copyOf(refs)));
    if (characters == 0 || chunks.isEmpty() || chunks.size() > 15) throw invalid();
    return List.copyOf(chunks);
  }
  private static AiFailure invalid() { return new AiFailure(JobError.AI_INVALID_RESPONSE); }
}
