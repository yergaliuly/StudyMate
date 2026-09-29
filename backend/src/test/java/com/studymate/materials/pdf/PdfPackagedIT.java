package com.studymate.materials.pdf;

import static org.assertj.core.api.Assertions.*;
import java.net.*;
import java.nio.file.*;
import java.util.jar.JarFile;
import org.junit.jupiter.api.Test;

class PdfPackagedIT {
  @Test void productionJarContainsOnlyProductionWorkerAndExtractsUsingItsOwnResources() throws Exception {
    Path jar=Path.of("target/studymate-backend-0.1.0-SNAPSHOT.jar").toAbsolutePath();
    try(var archive=new JarFile(jar.toFile())) {
      assertThat(archive.stream().map(e -> e.getName()).filter(n -> n.contains("PdfProcessMain")
          || n.contains("IsolationProbeMain") || n.contains("PdfFixtures") || n.contains("MaterialProcessMain"))).isEmpty();
      for(String resource:new String[]{"worker-isolated.jar","lib/pdfbox.jar","lib/fontbox.jar","lib/pdfbox-io.jar","lib/commons-logging.jar"})
        assertThat(archive.getEntry("BOOT-INF/classes/pdf-worker/"+resource)).isNotNull();
      try(var worker=new java.util.jar.JarInputStream(archive.getInputStream(archive.getEntry("BOOT-INF/classes/pdf-worker/worker-isolated.jar")))) {
        java.util.jar.JarEntry entry;
        while((entry=worker.getNextJarEntry())!=null) if(entry.getName().endsWith(".class"))
          assertThat(entry.getName()).startsWith("com/studymate/materials/pdf/worker/");
      }
    }
    // Resolve PdfProcess and all worker resources from the packaged application, not target/classes.
    try(var loader=new URLClassLoader(new URL[]{URI.create("jar:"+jar.toUri()+"!/BOOT-INF/classes/").toURL()},ClassLoader.getPlatformClassLoader());
        var workspace=new PdfWorkspace()) {
      Files.write(workspace.input(),PdfFixtures.text("Packaged runtime"));
      Class<?> parser=loader.loadClass(PdfProcess.class.getName());
      Object result=parser.getMethod("extract",Path.class,Path.class).invoke(parser.getConstructor().newInstance(),workspace.input(),workspace.directory());
      assertThat(result.getClass().getMethod("error").invoke(result)).isNull();
      assertThat(result.getClass().getMethod("pages").invoke(result)).isEqualTo(java.util.List.of("Packaged runtime"));
    }
  }
}
