package com.studymate.materials.pdf;

import static org.assertj.core.api.Assertions.*;
import java.nio.file.Files;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

class PdfProcessTest {
  private PdfResult parse(byte[] data) throws Exception {
    try(var workspace=new PdfWorkspace()) {
      Files.write(workspace.input(),data);
      return new PdfProcess().extract(workspace.input(),workspace.directory());
    }
  }
  @Test void extractsUnicodeByPhysicalPageAndPreservesBlankPages() throws Exception {
    var result=parse(PdfFixtures.text("Лекция 1. Алгебра","","Final page 3"));
    assertThat(result.error()).isNull();
    assertThat(result.pages()).hasSize(3);
    assertThat(result.pages().get(0)).contains("Лекция 1. Алгебра");
    assertThat(result.pages().get(1)).isEmpty();
    assertThat(result.pages().get(2)).contains("Final page 3");
    assertThat(result.characters()).isEqualTo(result.pages().stream().mapToInt(String::length).sum());
  }
  @Test void rejectsEncryptionIncludingEmptyPasswordAndPreservesInput() throws Exception {
    for(String password:new String[]{"","test-user"}) assertThat(parse(PdfFixtures.encrypted(password)).error()).isEqualTo("PDF_ENCRYPTED");
  }
  @Test void extractsStandardFontsWithoutScanningPrivateDirectories() throws Exception {
    var result=parse(PdfFixtures.standardFont());
    assertThat(result.error()).isNull(); assertThat(result.pages().getFirst()).contains("Standard font");
  }
  @Test void rejectsBrokenDocumentsAndDocumentsWithoutText() throws Exception {
    assertThat(parse("%PDF-1.7\nnot a document\n%%EOF".getBytes()).error()).isEqualTo("PDF_INVALID");
    assertThat(parse(PdfFixtures.text("","")).error()).isEqualTo("PDF_NO_TEXT");
    assertThat(parse(PdfFixtures.text("---")).error()).isEqualTo("PDF_NO_TEXT");
    assertThat(parse(PdfFixtures.scan()).error()).isEqualTo("PDF_NO_TEXT");
  }
  @Test void capsPhysicalPageCount() throws Exception {
    String[] pages=new String[200]; Arrays.fill(pages,""); pages[199]="Last";
    assertThat(parse(PdfFixtures.text(pages)).pages()).hasSize(200);
    assertThat(parse(PdfFixtures.text(Arrays.copyOf(pages,201))).error()).isEqualTo("PDF_TOO_MANY_PAGES");
  }
  @Test void capsTextPerPageAndAcrossDocument() throws Exception {
    assertThat(parse(PdfFixtures.text("A".repeat(100_000))).characters()).isEqualTo(100_000);
    assertThat(parse(PdfFixtures.text("A".repeat(100_001))).error()).isEqualTo("PDF_TEXT_LIMIT");
    String[] pages=new String[11]; Arrays.fill(pages,"A".repeat(95_000));
    assertThat(parse(PdfFixtures.text(pages)).error()).isEqualTo("PDF_TEXT_LIMIT");
  }
}
