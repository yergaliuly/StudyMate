package com.studymate.materials.pdf;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;

/** A private, disposable directory, not permanent lecture storage. Never follows symlinks during cleanup. */
public final class PdfWorkspace implements AutoCloseable {
  private final Path directory;
  public PdfWorkspace() throws IOException {
    Path base=Path.of(System.getProperty("java.io.tmpdir"));
    if(Files.getFileStore(base).supportsFileAttributeView("posix"))
      directory=Files.createTempDirectory(base,"studymate-pdf-",PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    else {
      directory=Files.createTempDirectory(base,"studymate-pdf-");
      var acl=Files.getFileAttributeView(directory,AclFileAttributeView.class);
      if(acl==null) { Files.delete(directory); throw new IOException("Private PDF directory requires POSIX permissions or ACL"); }
      try {
        acl.setAcl(List.of(AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(Files.getOwner(directory))
            .setPermissions(EnumSet.allOf(AclEntryPermission.class)).setFlags(AclEntryFlag.DIRECTORY_INHERIT,AclEntryFlag.FILE_INHERIT).build()));
      } catch(IOException failure) { Files.deleteIfExists(directory); throw failure; }
    }
  }
  public Path directory() { return directory; }
  public Path input() { return directory.resolve("input.pdf"); }
  @Override public void close() throws IOException {
    Files.walkFileTree(directory,new SimpleFileVisitor<>() {
      @Override public FileVisitResult visitFile(Path file,BasicFileAttributes attrs) throws IOException { Files.delete(file); return FileVisitResult.CONTINUE; }
      @Override public FileVisitResult postVisitDirectory(Path dir,IOException failure) throws IOException {
        if(failure!=null) throw failure; Files.delete(dir); return FileVisitResult.CONTINUE;
      }
    });
  }
}
