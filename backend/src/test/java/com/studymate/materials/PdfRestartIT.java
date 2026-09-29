package com.studymate.materials;

import static org.assertj.core.api.Assertions.*;
import com.studymate.PostgresIntegrationTest;
import com.studymate.materials.pdf.PdfFixtures;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest
class PdfRestartIT extends PostgresIntegrationTest {
  @Autowired MaterialRepository materials;
  @Autowired MaterialTextRepository texts;
  @Autowired JdbcTemplate jdbc;
  @Test void queuedThenKilledRunningJobRecoversAndSavedPagesSurviveAnotherRestart() throws Exception {
    UUID owner=UUID.randomUUID(),subject=UUID.randomUUID(); byte[] pdf=PdfFixtures.text("Persistent lecture","","Physical page 3");
    jdbc.update("INSERT INTO studymate.users(id,normalized_email,display_name,password_hash) VALUES (?,?,'PDF restart','{test-only}unusable')",owner,owner+"@example.com");
    jdbc.update("INSERT INTO studymate.subjects(id,owner_id,title,normalized_title,description,normalized_description,icon,tone) VALUES (?,?,'PDF','pdf','','','book','blue')",subject,owner);
    var input=new MaterialInput(subject,"Title","a.pdf",pdf.length,HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pdf)),null);
    var reserved=materials.reserve(owner,UUID.randomUUID(),input,"0".repeat(64)); materials.stored(owner,reserved.id());
    UUID id=reserved.id(),job=materials.get(owner,id).processingJobId();
    jdbc.update("UPDATE studymate.jobs SET lease_seconds=2,execution_timeout_seconds=120,retry_delay_seconds=1,max_retry_delay_seconds=2 WHERE id=?",job);
    // Other test classes share this dedicated test database; defer only their queued extraction fixtures.
    var deferred=jdbc.queryForList("SELECT id,next_attempt_at FROM studymate.jobs WHERE kind='material.extract_text' AND status='queued' AND id<>?",job);
    jdbc.update("UPDATE studymate.jobs SET next_attempt_at=clock_timestamp()+INTERVAL '1 day' WHERE kind='material.extract_text' AND status='queued' AND id<>?",job);
    var firstRead=new CountDownLatch(1); var release=new CountDownLatch(1); var reads=new AtomicInteger();
    var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0); var pool=Executors.newCachedThreadPool(); server.setExecutor(pool);
    server.createContext("/",exchange -> {
      try {
        if(!exchange.getRequestMethod().equals("GET") || !exchange.getRequestURI().getPath().endsWith(id+".pdf")) { exchange.sendResponseHeaders(404,-1); return; }
        if(reads.incrementAndGet()==1) { firstRead.countDown(); release.await(30,TimeUnit.SECONDS); }
        exchange.sendResponseHeaders(200,pdf.length); exchange.getResponseBody().write(pdf);
      } catch(Exception ignored) { /* First JVM is killed during its request. */ } finally { exchange.close(); }
    }); server.start();
    String endpoint="http://127.0.0.1:"+server.getAddress().getPort();
    try {
      assertThat(materials.get(owner,id).processingStatus()).isEqualTo("queued");
      try(var first=start(endpoint)) {
        assertThat(firstRead.await(30,TimeUnit.SECONDS)).isTrue(); assertThat(materials.get(owner,id).processingStatus()).isEqualTo("running");
        first.process.destroyForcibly(); assertThat(first.process.waitFor(10,TimeUnit.SECONDS)).isTrue(); release.countDown();
      }
      try(var second=start(endpoint)) {
        long until=System.nanoTime()+Duration.ofSeconds(40).toNanos();
        while(!materials.get(owner,id).processingStatus().equals("ready") && second.process.isAlive() && System.nanoTime()<until) Thread.sleep(50);
        assertThat(materials.get(owner,id).processingStatus()).as("see %s",second.log).isEqualTo("ready");
      }
      var saved=texts.pages(owner,id,1,100); assertThat(saved.data()).hasSize(3); assertThat(saved.data().get(1).text()).isEmpty();
      assertThat(reads.get()).isEqualTo(2);
      assertThat(jdbc.queryForObject("SELECT attempt_count FROM studymate.jobs WHERE id=?",Integer.class,job)).isEqualTo(2);
      try(var third=start(endpoint)) {
        long until=System.nanoTime()+Duration.ofSeconds(25).toNanos();
        while(!Files.readString(third.log).contains("Started PdfProcessMain") && third.process.isAlive() && System.nanoTime()<until) Thread.sleep(50);
        assertThat(Files.readString(third.log).contains("Started PdfProcessMain")).isTrue();
        assertThat(texts.pages(owner,id,1,100)).isEqualTo(saved); assertThat(reads.get()).isEqualTo(2);
      }
      assertThat(materials.usage(owner).usedBytes()).isEqualTo(pdf.length);
    } finally {
      release.countDown(); server.stop(0); pool.shutdownNow();
      for(var row:deferred) jdbc.update("UPDATE studymate.jobs SET next_attempt_at=? WHERE id=? AND status='queued'",row.get("next_attempt_at"),row.get("id"));
    }
  }
  private Running start(String endpoint) throws Exception {
    String cp=System.getProperty("surefire.test.class.path",System.getProperty("java.class.path"));
    Path args=Files.createTempFile(Path.of("target"),"pdf-process-",".args");
    Files.writeString(args,"-cp\n\""+cp.replace('\\','/')+"\"\n"+PdfProcessMain.class.getName()+"\n");
    Path log=Files.createTempFile(Path.of("target"),"pdf-process-",".log");
    var builder=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin","java").toString(),"@"+args,
        "--server.address=127.0.0.1","--server.port=0","--studymate.jobs.enabled=true","--studymate.jobs.poll-interval-ms=100",
        "--studymate.jobs.heartbeat-interval-ms=200","--studymate.materials.maintenance-enabled=false","--test.storage.endpoint="+endpoint)
        .redirectErrorStream(true).redirectOutput(log.toFile());
    for(String suffix:new String[]{"URL","USERNAME","PASSWORD"}) builder.environment().put("STUDYMATE_DATABASE_"+suffix,System.getenv("STUDYMATE_TEST_DATABASE_"+suffix));
    return new Running(builder.start(),log);
  }
  private record Running(Process process,Path log) implements AutoCloseable {
    public void close() throws Exception {
      if(!process.isAlive()) return; process.destroy();
      if(!process.waitFor(5,TimeUnit.SECONDS)) { process.destroyForcibly(); assertThat(process.waitFor(5,TimeUnit.SECONDS)).isTrue(); }
    }
  }
}
