package com.studymate.materials;

import static org.assertj.core.api.Assertions.*;
import com.studymate.PostgresIntegrationTest;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.file.*;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest
class MaterialRestartIT extends PostgresIntegrationTest {
  @Autowired MaterialRepository repository;
  @Autowired JdbcTemplate jdbc;

  @Test void killedJvmAfterRemoteDeleteAndExpiredUploadRecoverWithRealWorkerAndSdk() throws Exception {
    UUID owner=UUID.randomUUID(),subject=UUID.randomUUID();
    jdbc.update("INSERT INTO studymate.users(id,normalized_email,display_name,password_hash) VALUES (?,?,'Restart material','{test-only}unusable')",owner,owner+"@example.com");
    jdbc.update("INSERT INTO studymate.subjects(id,owner_id,title,normalized_title,description,normalized_description,icon,tone) VALUES (?,?,'Test','test','','','book','blue')",subject,owner);
    var input=new MaterialInput(subject,"Title","a.pdf",100,"0".repeat(64),null);
    var reserved=repository.reserve(owner,UUID.randomUUID(),input,"0".repeat(64)); repository.stored(owner,reserved.id());
    var deletion=repository.delete(owner,reserved.id());
    jdbc.update("UPDATE studymate.jobs SET lease_seconds=2,execution_timeout_seconds=30,retry_delay_seconds=1,max_retry_delay_seconds=2 WHERE id=?",deletion.jobId());
    var orphan=repository.reserve(owner,UUID.randomUUID(),input,"1".repeat(64));
    jdbc.update("UPDATE studymate.material_objects SET upload_expires_at=clock_timestamp()-INTERVAL '1 second',cleanup_not_before=clock_timestamp() WHERE id=?",orphan.id());
    var firstDelete=new CountDownLatch(1); var release=new CountDownLatch(1); var calls=new AtomicInteger();
    var present=new AtomicBoolean(true);
    var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
    var pool=Executors.newCachedThreadPool(); server.setExecutor(pool);
    server.createContext("/",exchange -> {
      try {
        if (!exchange.getRequestMethod().equals("DELETE")) { exchange.sendResponseHeaders(400,-1); return; }
        if (exchange.getRequestURI().getPath().endsWith(reserved.id()+".pdf")) {
          present.set(false);
          if (calls.incrementAndGet()==1) { firstDelete.countDown(); release.await(30,TimeUnit.SECONDS); }
        }
        exchange.sendResponseHeaders(204,-1);
      } catch (Exception ignored) { /* The first client is deliberately killed before receiving DELETE's response. */ }
      finally { exchange.close(); }
    }); server.start();
    String endpoint="http://127.0.0.1:"+server.getAddress().getPort();
    try {
      try(var first=start(endpoint)) {
        assertThat(firstDelete.await(35,TimeUnit.SECONDS)).isTrue();
        assertThat(present).isFalse(); assertThat(repository.usage(owner).usedBytes()).isEqualTo(100);
        assertThat(repository.usage(owner).reservedBytes()).isEqualTo(100);
        first.process.destroyForcibly(); assertThat(first.process.waitFor(10,TimeUnit.SECONDS)).isTrue(); release.countDown();
      }
      try(var second=start(endpoint)) {
        await(() -> repository.object(owner,reserved.id(),false).state().equals("deleted")
            && repository.object(owner,orphan.id(),false).state().equals("deleted"),second);
        assertThat(repository.usage(owner).usedBytes()).isZero(); assertThat(repository.usage(owner).reservedBytes()).isZero();
        assertThat(calls.get()).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT attempt_count FROM studymate.jobs WHERE id=?",Integer.class,deletion.jobId())).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.materials WHERE owner_id=?",Integer.class,owner)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.material_objects WHERE owner_id=? AND state='deleted'",Integer.class,owner)).isEqualTo(2);
      }
    } finally { release.countDown(); server.stop(0); pool.shutdownNow(); }
  }
  private static Running start(String endpoint) throws Exception {
    String cp=System.getProperty("surefire.test.class.path",System.getProperty("java.class.path"));
    Path args=Files.createTempFile(Path.of("target"),"materials-process-",".args");
    Files.writeString(args,"-cp\n\""+cp.replace('\\','/')+"\"\n"+MaterialProcessMain.class.getName()+"\n");
    Path log=Files.createTempFile(Path.of("target"),"materials-process-",".log");
    var builder=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin","java").toString(),"@"+args,
        "--server.address=127.0.0.1","--server.port=0","--studymate.jobs.enabled=true","--studymate.jobs.poll-interval-ms=100",
        "--studymate.jobs.heartbeat-interval-ms=200","--test.storage.endpoint="+endpoint)
        .redirectErrorStream(true).redirectOutput(log.toFile());
    for(String suffix:new String[]{"URL","USERNAME","PASSWORD"})
      builder.environment().put("STUDYMATE_DATABASE_"+suffix,System.getenv("STUDYMATE_TEST_DATABASE_"+suffix));
    return new Running(builder.start(),log);
  }
  private static void await(BooleanSupplier ready,Running child) throws Exception {
    long end=System.nanoTime()+Duration.ofSeconds(45).toNanos();
    while(System.nanoTime()<end && child.process.isAlive()) { if(ready.getAsBoolean()) return; Thread.sleep(50); }
    throw new AssertionError("Material restart did not finish; see "+child.log);
  }
  private record Running(Process process,Path log) implements AutoCloseable {
    public void close() throws Exception {
      if(!process.isAlive()) return;
      process.destroy();
      if(!process.waitFor(10,TimeUnit.SECONDS)) { process.destroyForcibly(); assertThat(process.waitFor(5,TimeUnit.SECONDS)).isTrue(); }
    }
  }
}
