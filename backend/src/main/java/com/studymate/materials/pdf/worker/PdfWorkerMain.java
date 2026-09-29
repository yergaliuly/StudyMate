package com.studymate.materials.pdf.worker;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException;
import org.apache.pdfbox.text.PDFTextStripper;

/** Standalone child entry point. No Spring, credentials, network or database dependencies. */
@SuppressWarnings("removal")
public final class PdfWorkerMain {
  private static final int MAX_PAGES=200, PAGE_CHARS=100_000, TOTAL_CHARS=1_000_000;
  public static void main(String[] args) {
    // Fail closed: this worker is supported only on the pinned Java 21 runtime with its restrictive policy.
    if (Runtime.version().feature()!=21 || System.getSecurityManager()==null) System.exit(70);
    Thread watchdog=new Thread(() -> {
      try { Thread.sleep(60_000); } catch(InterruptedException ignored) { return; }
      Runtime.getRuntime().halt(124);
    },"pdf-deadline");
    watchdog.setDaemon(true); watchdog.start();
    try {
      List<String> pages=extract(Path.of(args[0]));
      var output=new DataOutputStream(System.out);
      output.writeInt(0x534D5031); output.writeUTF("OK"); output.writeInt(pages.size());
      for(String page:pages) { byte[] text=page.getBytes(StandardCharsets.UTF_8); output.writeInt(text.length); output.write(text); }
      output.flush();
    } catch(InvalidPasswordException failure) { error("PDF_ENCRYPTED"); }
    catch(Limit failure) { error(failure.code); }
    catch(OutOfMemoryError failure) { Runtime.getRuntime().halt(3); }
    catch(SecurityException failure) { error("PDF_WORKER_FAILED"); }
    catch(IOException | RuntimeException failure) { error("PDF_INVALID"); }
    finally { watchdog.interrupt(); }
  }
  private static List<String> extract(Path file) throws IOException {
    // Strict parsing: don't silently repair truncated/broken documents into a misleading successful result.
    var source=new org.apache.pdfbox.io.RandomAccessReadBufferedFile(file);
    try(source) {
      var parser=new org.apache.pdfbox.pdfparser.PDFParser(source);
      try(PDDocument document=parser.parse(false)) {
        if(document.isEncrypted()) throw new Limit("PDF_ENCRYPTED");
        int count=document.getNumberOfPages();
        if(count>MAX_PAGES) throw new Limit("PDF_TOO_MANY_PAGES");
        if(count<1) throw new Limit("PDF_INVALID");
        List<String> pages=new ArrayList<>(); int total=0; boolean textFound=false;
        for(int number=1;number<=count;number++) {
          var writer=new BoundedText(Math.min(PAGE_CHARS,TOTAL_CHARS-total));
          var stripper=new PDFTextStripper();
          stripper.setSortByPosition(true); stripper.setStartPage(number); stripper.setEndPage(number);
          stripper.setLineSeparator("\n"); stripper.setPageStart(""); stripper.setPageEnd("");
          stripper.writeText(document,writer);
          String text=writer.value(); total+=text.length();
          if(text.codePoints().anyMatch(c -> Character.isLetterOrDigit(c))) textFound=true;
          pages.add(text);
        }
        if(!textFound) throw new Limit("PDF_NO_TEXT");
        return pages;
      }
    }
  }
  private static void error(String code) {
    try { var output=new DataOutputStream(System.out); output.writeInt(0x534D5031); output.writeUTF(code); output.flush(); }
    catch(IOException ignored) { System.exit(70); }
  }
  private static final class Limit extends IOException {
    final String code;
    Limit(String code) { super(code); this.code=code; }
  }
  private static final class BoundedText extends Writer {
    private final StringBuilder text=new StringBuilder();
    private final int maximum;
    BoundedText(int maximum) { this.maximum=maximum; }
    @Override public void write(char[] buffer,int start,int length) throws IOException {
      if(length>maximum-text.length()) throw new Limit("PDF_TEXT_LIMIT");
      for(int i=start;i<start+length;i++) {
        char c=buffer[i]; text.append(c==0 ? '\uFFFD' : c);
      }
    }
    String value() {
      // PostgreSQL text cannot store NUL/unpaired surrogates. Preserve pages and line breaks, not invalid encoding.
      for(int i=0;i<text.length();i++) {
        char c=text.charAt(i);
        if(Character.isHighSurrogate(c) && i+1<text.length() && Character.isLowSurrogate(text.charAt(i+1))) { i++; continue; }
        if(Character.isSurrogate(c)) text.setCharAt(i,'\uFFFD');
      }
      return text.toString();
    }
    @Override public void flush() {}
    @Override public void close() {}
  }
}
