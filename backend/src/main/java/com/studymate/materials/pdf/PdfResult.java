package com.studymate.materials.pdf;

import java.util.List;

public record PdfResult(List<String> pages, String error) {
  public PdfResult { pages = List.copyOf(pages); }
  public static PdfResult failed(String code) { return new PdfResult(List.of(),code); }
  public int characters() { return pages.stream().mapToInt(String::length).sum(); }
  @Override public String toString() { return "PdfResult[redacted]"; }
}
