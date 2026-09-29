package com.studymate.materials.pdf;

import java.io.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.encryption.*;

/** Generated test data only; no user documents. */
public final class PdfFixtures {
  public static byte[] scan() throws IOException {
    try(var doc=new PDDocument(); var output=new ByteArrayOutputStream()) {
      var page=new PDPage(); doc.addPage(page);
      var image=new java.awt.image.BufferedImage(20,20,java.awt.image.BufferedImage.TYPE_INT_RGB);
      try(var content=new PDPageContentStream(doc,page)) {
        content.drawImage(org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory.createFromImage(doc,image),20,20);
      }
      doc.save(output); return output.toByteArray();
    }
  }
  public static byte[] standardFont() throws IOException {
    try(var doc=new PDDocument(); var output=new ByteArrayOutputStream()) {
      var page=new PDPage(); doc.addPage(page);
      try(var content=new PDPageContentStream(doc,page)) {
        content.beginText(); content.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA),12);
        content.newLineAtOffset(20,700); content.showText("Standard font"); content.endText();
      }
      doc.save(output); return output.toByteArray();
    }
  }
  public static byte[] text(String... pages) throws IOException { return document(null,pages); }
  public static byte[] encrypted(String password) throws IOException { return document(password,"Secret test lecture"); }
  private static byte[] document(String password,String... pages) throws IOException {
    try(var doc=new PDDocument(); var output=new ByteArrayOutputStream();
        var fontSource=PDFont.class.getResourceAsStream("/org/apache/pdfbox/resources/ttf/LiberationSans-Regular.ttf")) {
      var font=PDType0Font.load(doc,fontSource);
      for(String text:pages) {
        var page=new PDPage(); doc.addPage(page);
        if(text==null || text.isEmpty()) continue;
        try(var content=new PDPageContentStream(doc,page)) {
          content.beginText(); content.setFont(font,12); content.newLineAtOffset(20,700);
          // Long fixtures remain a single physical page, irrespective of visual overflow.
          content.showText(text); content.endText();
        }
      }
      if(password!=null) doc.protect(new StandardProtectionPolicy("test-owner",password,new AccessPermission()));
      doc.save(output); return output.toByteArray();
    }
  }
}
