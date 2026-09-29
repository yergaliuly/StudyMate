package com.studymate.materials;

import static org.assertj.core.api.Assertions.*;
import com.studymate.common.api.ApiException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockPart;

class MaterialInputTest {
  static final byte[] PDF = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n".getBytes(StandardCharsets.US_ASCII);
  static MockHttpServletRequest request(byte[] bytes, String name, String title) {
    var request = new MockHttpServletRequest();
    request.addPart(new MockPart("file",name,bytes));
    request.addPart(new MockPart("subjectId",UUID.randomUUID().toString().getBytes(StandardCharsets.UTF_8)));
    if (title != null) request.addPart(new MockPart("title",title.getBytes(StandardCharsets.UTF_8)));
    return request;
  }
  @Test void stripsClientPathsAndDefaultsOptionalTitle() throws Exception {
    var result = MaterialInput.read(request(PDF,"C:\\fakepath\\ Лекция  1.pdf",null));
    assertThat(result.title()).isEqualTo("Лекция 1");
    assertThat(result.fileName()).isEqualTo("Лекция  1.pdf");
    assertThat(result.sizeBytes()).isEqualTo(PDF.length);
    assertThat(result.sha256()).hasSize(64);
    assertThat(MaterialInput.read(request(PDF,".pdf","  ")).title()).isEqualTo("Материал");
    assertThat(MaterialInput.read(request(PDF,"a.pdf","  Новое   имя  ")).title()).isEqualTo("Новое имя");
  }
  @ParameterizedTest @ValueSource(strings={"", "hello", "%PDF-1.7 missing trailer", "garbage %PDF-1.7\n%%EOF", "%PDF-3.0\n%%EOF"})
  void rejectsInvalidEnvelope(String bytes) {
    assertThatThrownBy(() -> MaterialInput.read(request(bytes.getBytes(StandardCharsets.US_ASCII),"a.pdf",null)))
        .isInstanceOf(ApiException.class).extracting(e -> ((ApiException)e).response().error().code()).isEqualTo("INVALID_PDF");
  }
  @Test void rejectsWrongExtensionMimeUnicodeFieldsAndDuplicateParts() {
    assertThatThrownBy(() -> MaterialInput.read(request(PDF,"a.exe",null))).isInstanceOf(ApiException.class);
    var wrongMime=request(PDF,"a.pdf",null);
    ((MockPart)uncheckedPart(wrongMime,"file")).getHeaders().setContentType(org.springframework.http.MediaType.TEXT_HTML);
    assertThatThrownBy(() -> MaterialInput.read(wrongMime)).isInstanceOf(ApiException.class);
    for (String title : new String[]{"x".repeat(161),"a\0b","a\uD800b"})
      assertThatThrownBy(() -> MaterialInput.title(title)).isInstanceOf(ApiException.class);
    var duplicate=request(PDF,"a.pdf",null); duplicate.addPart(new MockPart("file","b.pdf",PDF));
    assertThatThrownBy(() -> MaterialInput.read(duplicate)).isInstanceOf(ApiException.class);
    var unknown=request(PDF,"a.pdf",null); unknown.addPart(new MockPart("ownerId",new byte[]{1}));
    assertThatThrownBy(() -> MaterialInput.read(unknown)).isInstanceOf(ApiException.class);
  }
  @Test void exactFileBoundaryIsInclusiveAndIndependentOfDeclaredSize() throws Exception {
    byte[] max = new byte[(int)MaterialLimits.MAX_UPLOAD_BYTES];
    java.util.Arrays.fill(max,(byte)' ');
    System.arraycopy("%PDF-1.7".getBytes(StandardCharsets.US_ASCII),0,max,0,8);
    System.arraycopy("%%EOF".getBytes(StandardCharsets.US_ASCII),0,max,max.length-5,5);
    assertThat(MaterialInput.read(request(max,"a.pdf",null)).sizeBytes()).isEqualTo(26_214_400);
    byte[] overflow=java.util.Arrays.copyOf(max,max.length+1);
    assertThatThrownBy(() -> MaterialInput.read(request(overflow,"a.pdf",null))).isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException)e).status().value()).isEqualTo(413);
    var part=new MockPart("file","a.pdf",PDF) { @Override public long getSize() { return 1; } };
    var fake=new MockHttpServletRequest(); fake.addPart(part);
    fake.addPart(new MockPart("subjectId",UUID.randomUUID().toString().getBytes(StandardCharsets.US_ASCII)));
    assertThatThrownBy(() -> MaterialInput.read(fake)).isInstanceOf(ApiException.class);
  }
  private static jakarta.servlet.http.Part uncheckedPart(MockHttpServletRequest request,String name) {
    try { return request.getPart(name); } catch(Exception e) { throw new RuntimeException(e); }
  }
}
