package com.studymate.materials.pdf;

import static org.assertj.core.api.Assertions.*;
import java.io.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import java.util.jar.*;
import org.junit.jupiter.api.Test;

class PdfIsolationTest {
  private List<String> command(PdfWorkspace workspace,String mode) throws Exception {
    Files.writeString(workspace.input(),mode);
    Path runtime=Files.createDirectory(workspace.directory().resolve("runtime"));
    String resource=IsolationProbeMain.class.getName().replace('.','/')+".class";
    try(var jar=new JarOutputStream(Files.newOutputStream(runtime.resolve("worker-isolated.jar")));
        var source=IsolationProbeMain.class.getResourceAsStream("/"+resource)) {
      jar.putNextEntry(new JarEntry(resource)); source.transferTo(jar); jar.closeEntry();
    }
    return PdfProcess.command(workspace.input(),workspace.directory(),runtime,IsolationProbeMain.class.getName());
  }
  @Test void deniesOtherFilesWritesNetworkExecEnvironmentAndApplicationClasspath() throws Exception {
    Path unrelated=Files.createTempFile("private-test-only-",".txt");
    try(var workspace=new PdfWorkspace()) {
      Files.writeString(unrelated,"test-only secret");
      var result=PdfProcess.run(command(workspace,unrelated.toString()),workspace.directory(),Duration.ofSeconds(5));
      assertThat(result.error()).isNull(); assertThat(result.pages()).containsExactly("denied=7");
      assertThat(Files.exists(Path.of(workspace.input()+".other"))).isFalse();
    } finally { Files.delete(unrelated); }
  }
  @Test void enforcesHeapAndProtocolOutputBounds() throws Exception {
    try(var workspace=new PdfWorkspace()) {
      assertThat(PdfProcess.run(command(workspace,"memory"),workspace.directory(),Duration.ofSeconds(5)).error()).isEqualTo("PDF_RESOURCE_LIMIT");
    }
    try(var workspace=new PdfWorkspace()) {
      assertThat(PdfProcess.run(command(workspace,"output"),workspace.directory(),Duration.ofSeconds(5)).error()).isEqualTo("PDF_WORKER_FAILED");
    }
  }
  @Test void timeoutAndCancellationKillChildBeforeReturning() throws Exception {
    try(var workspace=new PdfWorkspace()) {
      assertThat(PdfProcess.run(command(workspace,"hang"),workspace.directory(),Duration.ofMillis(400)).error()).isEqualTo("PDF_TIMEOUT");
      assertThat(probes()).isEmpty();
    }
    try(var workspace=new PdfWorkspace(); var executor=Executors.newSingleThreadExecutor()) {
      var cmd=command(workspace,"hang"); var done=new CountDownLatch(1);
      var future=executor.submit(() -> {
        try { PdfProcess.run(cmd,workspace.directory(),Duration.ofSeconds(30)); }
        catch(InterruptedException expected) { } catch(IOException failure) { throw new AssertionError(failure); }
        finally { done.countDown(); }
      });
      long end=System.nanoTime()+Duration.ofSeconds(5).toNanos();
      while(probes().isEmpty() && System.nanoTime()<end) Thread.sleep(10);
      try { assertThat(probes()).hasSize(1); } finally { future.cancel(true); }
      assertThat(done.await(5,TimeUnit.SECONDS)).isTrue(); assertThat(probes()).isEmpty();
    }
  }
  private List<ProcessHandle> probes() {
    // Windows does not expose commandLine through ProcessHandle.Info. This test JVM launches one child at a time.
    return ProcessHandle.current().children().filter(ProcessHandle::isAlive).toList();
  }
  @Test void rejectsMalformedAndOversizedChildProtocol() throws Exception {
    assertThat(PdfProcess.decode(new byte[0]).error()).isEqualTo("PDF_WORKER_FAILED");
    assertThat(PdfProcess.decode(new byte[PdfProcess.MAX_OUTPUT+1]).error()).isEqualTo("PDF_WORKER_FAILED");
    for(String code:List.of("secret-provider-message","OK","PDF_NO_TEXT")) {
      var bytes=new ByteArrayOutputStream(); var out=new DataOutputStream(bytes);
      out.writeInt(0x534D5031); out.writeUTF(code); out.writeInt(201);
      assertThat(PdfProcess.decode(bytes.toByteArray()).error()).isEqualTo("PDF_WORKER_FAILED");
    }
  }
}
