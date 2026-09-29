package com.studymate.materials.pdf;

import java.io.*;
import java.net.Socket;
import java.nio.file.*;

/** Test-only executable, packaged by PdfIsolationTest into its disposable worker jar. */
public final class IsolationProbeMain {
  public static void main(String[] args) throws Exception {
    String mode=Files.readString(Path.of(args[0]));
    if(mode.equals("hang")) { Thread.sleep(30_000); return; }
    if(mode.equals("memory")) { System.out.write(new byte[512*1024*1024]); return; }
    if(mode.equals("output")) { System.out.write(new byte[4_002_049]); return; }
    int denied=0;
    try { Files.readString(Path.of(mode)); } catch(SecurityException expected) { denied++; }
    try { Files.writeString(Path.of(args[0]+".other"),"bad"); } catch(SecurityException expected) { denied++; }
    try(var socket=new Socket("127.0.0.1",1)) { } catch(SecurityException expected) { denied++; }
    try { new ProcessBuilder("arbitrary-child-process").start(); } catch(SecurityException expected) { denied++; }
    try { System.getenv(); } catch(SecurityException expected) { denied++; }
    try { Class.forName("org.springframework.context.ApplicationContext"); } catch(ClassNotFoundException expected) { denied++; }
    try { Class.forName("org.postgresql.Driver"); } catch(ClassNotFoundException expected) { denied++; }
    var out=new DataOutputStream(System.out); out.writeInt(0x534D5031); out.writeUTF("OK"); out.writeInt(1);
    byte[] text=("denied="+denied).getBytes(java.nio.charset.StandardCharsets.UTF_8);
    out.writeInt(text.length); out.write(text); out.flush();
  }
}
