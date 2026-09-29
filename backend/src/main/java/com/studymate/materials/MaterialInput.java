package com.studymate.materials;

import com.studymate.common.api.ApiException;
import com.studymate.common.validation.TextInput;
import com.studymate.common.validation.WellFormedUnicodeValidator;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.Part;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;

record MaterialInput(UUID subjectId, String title, String fileName, long sizeBytes, String sha256, Part file) {
  static MaterialInput read(HttpServletRequest request) throws Exception {
    noQuery(request);
    java.util.Collection<Part> parts;
    try { parts = request.getParts(); }
    catch (jakarta.servlet.ServletException | IllegalStateException failure) {
      for (Throwable cause=failure; cause!=null; cause=cause.getCause()) {
        if (cause.getClass().getSimpleName().contains("SizeLimitExceeded")) throw tooLarge();
      }
      throw error(HttpStatus.BAD_REQUEST,"INVALID_MULTIPART","Проверь формат multipart.");
    }
    if (parts.size() < 2 || parts.size() > 3 || parts.stream().anyMatch(p -> !Set.of("file", "subjectId", "title").contains(p.getName()))
        || parts.stream().map(Part::getName).distinct().count() != parts.size()) throw invalid("file");
    Part file = request.getPart("file"), subject = request.getPart("subjectId"), title = request.getPart("title");
    if (file == null || subject == null || file.getSubmittedFileName() == null || subject.getSubmittedFileName() != null
        || (title != null && title.getSubmittedFileName() != null)) throw invalid("file");
    String mime = file.getContentType();
    if (mime != null && !mime.equalsIgnoreCase("application/pdf") && !mime.equalsIgnoreCase("application/octet-stream")) throw invalidPdf();
    String name = file.getSubmittedFileName().replace('\\', '/');
    name = TextInput.trim(name.substring(name.lastIndexOf('/') + 1));
    if (!textValid(name) || name.isEmpty() || name.length() > 180 || !name.toLowerCase(java.util.Locale.ROOT).endsWith(".pdf")) throw invalid("file");
    String label = title == null ? null : text(title, 640);
    if (label == null || TextInput.trim(label).isEmpty()) {
      label = TextInput.title(name.substring(0, name.length() - 4));
      if (label.length() > 160) label = label.substring(0, Character.isHighSurrogate(label.charAt(159)) ? 159 : 160);
      if (label.isEmpty()) label = "Материал";
    }
    label = title(label);
    UUID subjectId = id(text(subject, 36));
    if (file.getSize() > MaterialLimits.MAX_UPLOAD_BYTES) throw tooLarge();
    var digest = MessageDigest.getInstance("SHA-256");
    long size = 0;
    byte[] first = new byte[8], tail = new byte[1024], buffer = new byte[8192];
    try (var stream = file.getInputStream()) {
      int read;
      while ((read = stream.read(buffer)) != -1) {
        if (size + read > MaterialLimits.MAX_UPLOAD_BYTES) throw tooLarge();
        for (int i = 0; i < read; i++) {
          if (size + i < first.length) first[(int)size + i] = buffer[i];
          tail[(int)((size + i) % tail.length)] = buffer[i];
        }
        digest.update(buffer, 0, read); size += read;
      }
    }
    byte[] ending = new byte[(int)Math.min(size, tail.length)];
    for (int i = 0; i < ending.length; i++) ending[i] = tail[(int)((size - ending.length + i) % tail.length)];
    String header = new String(first, StandardCharsets.US_ASCII);
    if (size != file.getSize() || size < 14 || !header.matches("%PDF-(?:1\\.[0-7]|2\\.0)")
        || !new String(ending, StandardCharsets.ISO_8859_1).stripTrailing().endsWith("%%EOF")) throw invalidPdf();
    return new MaterialInput(subjectId, label, name, size, HexFormat.of().formatHex(digest.digest()), file);
  }

  static String title(String raw) {
    String value = TextInput.title(raw);
    if (value == null || value.isEmpty() || value.length() > 160 || !textValid(value)) throw invalid("title");
    return value;
  }
  static boolean textValid(String text) {
    return new WellFormedUnicodeValidator().isValid(text, null) && text.chars().noneMatch(c -> c < 32 || c == 127);
  }
  private static String text(Part part, int max) throws IOException {
    if (part.getSize() > max) throw invalid(part.getName());
    try (var stream = part.getInputStream()) {
      byte[] bytes = stream.readNBytes(max + 1);
      if (bytes.length > max) throw invalid(part.getName());
      try { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes)).toString(); }
      catch (java.nio.charset.CharacterCodingException error) { throw invalid(part.getName()); }
    }
  }
  static UUID id(String value) {
    if (value == null || !value.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"))
      throw error(HttpStatus.BAD_REQUEST, "INVALID_ID", "Идентификатор должен быть UUID.");
    return UUID.fromString(value);
  }
  static UUID key(HttpServletRequest request) {
    var values = Collections.list(request.getHeaders("Idempotency-Key"));
    if (values.isEmpty()) throw error(HttpStatus.BAD_REQUEST, "IDEMPOTENCY_KEY_REQUIRED", "Передай Idempotency-Key.");
    if (values.size() != 1 || !values.getFirst().matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"))
      throw error(HttpStatus.BAD_REQUEST, "INVALID_IDEMPOTENCY_KEY", "Ключ запроса должен быть UUID.");
    return UUID.fromString(values.getFirst());
  }
  static void noQuery(HttpServletRequest request) {
    if (request.getQueryString() != null && !request.getQueryString().isEmpty())
      throw error(HttpStatus.BAD_REQUEST, "INVALID_QUERY", "Этот запрос не принимает query.");
  }
  static ApiException invalid(String field) {
    return new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "VALIDATION_FAILED", "Проверь поля загрузки.", Map.of(field, "Недопустимое значение."));
  }
  static ApiException invalidPdf() { return error(HttpStatus.UNPROCESSABLE_CONTENT, "INVALID_PDF", "Нужен непустой PDF с корректными заголовком и окончанием."); }
  static ApiException tooLarge() { return error(HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "PDF должен быть не больше 26 214 400 байт."); }
  static ApiException error(HttpStatus status, String code, String message) { return new ApiException(status, code, message, Map.of()); }
  @Override public String toString() { return "MaterialInput[redacted]"; }
}
