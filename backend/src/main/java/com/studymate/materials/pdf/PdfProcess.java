package com.studymate.materials.pdf;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.stereotype.Component;

/** Executes only the minimal worker artifact. stdout is a bounded binary protocol; stderr is discarded. */
@Component
public class PdfProcess {
  static final int MAX_OUTPUT=4_002_048;
  static final String MAIN="com.studymate.materials.pdf.worker.PdfWorkerMain";
  private static final Set<String> ERRORS=Set.of("PDF_INVALID","PDF_ENCRYPTED","PDF_NO_TEXT","PDF_TOO_MANY_PAGES",
      "PDF_TEXT_LIMIT","PDF_TIMEOUT","PDF_RESOURCE_LIMIT","PDF_WORKER_FAILED");
  private static final List<String> RESOURCES=List.of("worker-isolated.jar","lib/pdfbox.jar","lib/fontbox.jar","lib/pdfbox-io.jar","lib/commons-logging.jar");

  public PdfResult extract(Path input, Path workspace) throws IOException, InterruptedException {
    if(Runtime.version().feature()!=21) return PdfResult.failed("PDF_WORKER_FAILED");
    Path runtime=Files.createDirectory(workspace.resolve("runtime"));
    for(String name:RESOURCES) {
      Path target=runtime.resolve(name); Files.createDirectories(target.getParent());
      try(var source=PdfProcess.class.getResourceAsStream("/pdf-worker/"+name)) {
        if(source==null) throw new IOException("Isolated PDF runtime is missing; run Maven process-classes/package");
        Files.copy(source,target);
      }
    }
    var command=command(input,workspace,runtime,MAIN);
    return run(command,workspace,Duration.ofSeconds(60));
  }

  static List<String> command(Path input,Path workspace,Path runtime,String main) throws IOException {
    Path policy=workspace.resolve("worker.policy");
    String rules="""
        grant {
          permission java.util.PropertyPermission "*", "read";
          permission java.lang.RuntimePermission "exitVM.*";
          permission java.lang.RuntimePermission "getClassLoader";
          permission java.lang.RuntimePermission "accessDeclaredMembers";
          permission java.lang.RuntimePermission "modifyThread";
          permission java.lang.RuntimePermission "modifyThreadGroup";
          permission java.io.FilePermission "%s", "read";
          permission java.io.FilePermission "%s/-", "read";
          permission java.io.FilePermission "%s/-", "read";
        };
        """.formatted(policyPath(input),policyPath(runtime),policyPath(Path.of(System.getProperty("java.home"))));
    Files.writeString(policy,rules,StandardCharsets.UTF_8);
    return List.of(Path.of(System.getProperty("java.home"),"bin",isWindows()?"java.exe":"java").toString(),
        "-Xms16m","-Xmx256m","-Xss512k","-XX:MaxMetaspaceSize=64m","-XX:MaxDirectMemorySize=16m",
        "-XX:ReservedCodeCacheSize=32m","-XX:+ExitOnOutOfMemoryError","-XX:-HeapDumpOnOutOfMemoryError","-XX:-CreateCoredumpOnCrash",
        "-Djava.awt.headless=true","-Djava.security.manager=default","-Djava.security.policy=="+policy.toUri(),
        "-Duser.home="+workspace,"-Djava.io.tmpdir="+workspace,
        "-Dorg.apache.commons.logging.Log=org.apache.commons.logging.impl.NoOpLog",
        "-cp",runtime.resolve("worker-isolated.jar")+File.pathSeparator+runtime.resolve("lib")+File.separator+"*",main,input.toAbsolutePath().toString());
  }
  static PdfResult run(List<String> command,Path workspace,Duration timeout) throws IOException,InterruptedException {
    ProcessBuilder builder=new ProcessBuilder(command).directory(workspace.toFile()).redirectError(ProcessBuilder.Redirect.DISCARD);
    // In particular remove database/R2 keys and JAVA_TOOL_OPTIONS/JDK_JAVA_OPTIONS injected into child JVMs.
    String systemRoot=System.getenv("SystemRoot");
    builder.environment().clear();
    if(systemRoot!=null) builder.environment().put("SystemRoot",systemRoot);
    builder.environment().put("TEMP",workspace.toString()); builder.environment().put("TMP",workspace.toString());
    Process process=builder.start();
    process.getOutputStream().close();
    ExecutorService reader=Executors.newSingleThreadExecutor(Thread.ofPlatform().daemon(true).name("pdf-output-").factory());
    Future<byte[]> bytes=reader.submit(() -> {
      try(var output=process.getInputStream()) {
        byte[] result=output.readNBytes(MAX_OUTPUT+1);
        if(result.length>MAX_OUTPUT) process.destroyForcibly();
        return result;
      }
    });
    try {
      if(!process.waitFor(timeout.toMillis(),TimeUnit.MILLISECONDS)) return PdfResult.failed("PDF_TIMEOUT");
      if(process.exitValue()==3) return PdfResult.failed("PDF_RESOURCE_LIMIT");
      if(process.exitValue()==124) return PdfResult.failed("PDF_TIMEOUT");
      if(process.exitValue()!=0) return PdfResult.failed("PDF_WORKER_FAILED");
      try { return decode(bytes.get(2,TimeUnit.SECONDS)); }
      catch(ExecutionException | TimeoutException failure) { return PdfResult.failed("PDF_WORKER_FAILED"); }
    } finally {
      process.destroyForcibly();
      // Even cancellation/interruption cannot release the worker slot while the parser still runs.
      boolean interrupted=Thread.interrupted();
      try {
        long stopBy=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(process.isAlive() && System.nanoTime()<stopBy) {
          try { process.waitFor(100,TimeUnit.MILLISECONDS); }
          catch(InterruptedException e) { interrupted=true; process.destroyForcibly(); }
        }
        if(process.isAlive()) throw new IOException("PDF child failed to stop");
      }
      finally { reader.shutdownNow(); if(interrupted) Thread.currentThread().interrupt(); }
    }
  }
  static PdfResult decode(byte[] bytes) {
    if(bytes.length>MAX_OUTPUT) return PdfResult.failed("PDF_WORKER_FAILED");
    try(var in=new DataInputStream(new ByteArrayInputStream(bytes))) {
      if(in.readInt()!=0x534D5031) throw new IOException();
      String code=in.readUTF();
      if(!code.equals("OK")) {
        if(!ERRORS.contains(code) || in.available()!=0) throw new IOException();
        return PdfResult.failed(code);
      }
      int count=in.readInt(),total=0;
      if(count<1 || count>200) throw new IOException();
      List<String> pages=new ArrayList<>(); boolean hasText=false;
      for(int i=0;i<count;i++) {
        int length=in.readInt(); if(length<0 || length>400_000 || length>in.available()) throw new IOException();
        String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(in.readNBytes(length))).toString();
        if(text.length()>100_000 || (total+=text.length())>1_000_000 || text.indexOf(0)>=0) throw new IOException();
        hasText |= text.codePoints().anyMatch(Character::isLetterOrDigit); pages.add(text);
      }
      if(in.available()!=0 || !hasText) throw new IOException();
      return new PdfResult(pages,null);
    } catch(IOException | RuntimeException failure) { return PdfResult.failed("PDF_WORKER_FAILED"); }
  }
  private static String policyPath(Path path) { return path.toAbsolutePath().normalize().toString().replace('\\','/').replace("\"","\\\""); }
  private static boolean isWindows() { return System.getProperty("os.name").startsWith("Windows"); }
}
