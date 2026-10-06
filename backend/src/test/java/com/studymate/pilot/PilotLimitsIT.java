package com.studymate.pilot;

import static org.assertj.core.api.Assertions.*;

import com.studymate.common.api.ApiException;
import com.studymate.identity.AuthHttpClient;
import com.studymate.jobs.JobQueue;
import com.studymate.jobs.RetryPolicy;
import java.util.ArrayList;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT, properties={
    "spring.profiles.active=local", "studymate.ai.provider=fake", "studymate.registration.enabled=true",
    "studymate.registration.allowed-emails=", "studymate.jobs.enabled=false", "studymate.materials.maintenance-enabled=false",
    "studymate.limits.enabled=true", "studymate.limits.login-per-minute=5",
    "studymate.limits.login-per-email-quarter-hour=2", "studymate.limits.account-requests-per-minute=30",
    "studymate.limits.ai-per-account-day=2", "studymate.limits.ai-total-per-day=3"})
class PilotLimitsIT {
  @DynamicPropertySource static void database(DynamicPropertyRegistry values) {
    values.add("spring.datasource.url", () -> required("STUDYMATE_TEST_DATABASE_URL"));
    values.add("spring.datasource.username", () -> required("STUDYMATE_TEST_DATABASE_USERNAME"));
    values.add("spring.datasource.password", () -> required("STUDYMATE_TEST_DATABASE_PASSWORD"));
  }
  private static String required(String name) {
    String value=System.getenv(name);
    if (value==null || value.isBlank()) throw new IllegalStateException("Configure isolated test database: "+name);
    return value;
  }
  @Value("${local.server.port}") int port;
  @Autowired JdbcTemplate jdbc;
  @Autowired JdbcClient client;
  @Autowired PilotLimits limits;
  @Autowired PilotProperties settings;
  @Autowired PlatformTransactionManager transactions;
  @Autowired JobQueue jobs;
  @Autowired JsonMapper json;

  @BeforeEach void resetOnlyDisposableCounters() { jdbc.update("DELETE FROM studymate.request_limits"); }

  @Test void globalLoginBudgetAppliesBeforeCsrfAndCannotBeBypassedWithForwardedHeaders() throws Exception {
    try(var http=new AuthHttpClient(port)) {
      for(int i=0;i<5;i++) assertThat(http.error(http.send("POST","/auth/login",Map.of(),null,
          Map.of("X-Forwarded-For","192.0.2."+(i+1))),403)).isEqualTo("CSRF_INVALID");
      var blocked=http.send("POST","/auth/login",Map.of(),null,Map.of("X-Forwarded-For","203.0.113.10"));
      assertThat(http.error(blocked,429)).isEqualTo("RATE_LIMITED");
      assertThat(Integer.parseInt(blocked.headers().firstValue("Retry-After").orElseThrow())).isBetween(1,60);
      // Unrelated bootstrap is not locked by the exhausted login window.
      http.csrf();
    }
  }

  @Test void invalidUnsafeRequestsCannotAllocateUnlimitedAnonymousSessions() throws Exception {
    long before=jdbc.queryForObject("SELECT count(*) FROM studymate.spring_session",Long.class);
    try(var http=new AuthHttpClient(port)) {
      for(int i=0;i<12;i++) {
        http.cookie=i%2==0?null:"STUDYMATE_SESSION="+java.util.Base64.getEncoder()
            .encodeToString(UUID.randomUUID().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var response=http.send("POST",i%3==0?"/auth/logout":"/nonexistent",null,"forged-token");
        assertThat(http.error(response,403)).isEqualTo("CSRF_INVALID");
        assertThat(response.headers().allValues("Set-Cookie")).noneMatch(value->!value.contains("Max-Age=0"));
      }
    }
    assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.spring_session",Long.class)).isEqualTo(before);
  }

  @Test void httpAccountLimitRejectsOnlyTheExhaustedAccount() throws Exception {
    try(var first=new AuthHttpClient(port);var second=new AuthHttpClient(port)) {
      String one="api-one-"+UUID.randomUUID()+"@example.com", two="api-two-"+UUID.randomUUID()+"@example.com";
      UUID owner=UUID.fromString(first.register(one)); first.data(first.login(one),200);
      second.register(two);second.data(second.login(two),200);
      // Registration/login are anonymous; use the remaining exact account window from PostgreSQL.
      Integer used=client.sql("SELECT used FROM studymate.request_limits WHERE bucket='account-api' AND subject=:owner")
          .param("owner",owner.toString()).query(Integer.class).optional().orElse(0);
      for(int i=used;i<30;i++) first.data(first.send("GET","/auth/me",null,null),200);
      var blocked=first.send("GET","/auth/me",null,null);
      assertThat(first.error(blocked,429)).isEqualTo("RATE_LIMITED");
      assertThat(Integer.parseInt(blocked.headers().firstValue("Retry-After").orElseThrow())).isBetween(1,60);
      second.data(second.send("GET","/auth/me",null,null),200);
    }
  }

  @Test void wrongPasswordsConsumeSharedNormalizedEmailBudgetEvenThoughLoginFails() throws Exception {
    String email="limit-"+UUID.randomUUID()+"@example.com";
    try(var http=new AuthHttpClient(port)) {
      http.csrf();
      for(int i=0;i<2;i++) assertThat(http.error(http.login(email),401)).isEqualTo("INVALID_CREDENTIALS");
      var blocked=http.login("  "+email.toUpperCase(java.util.Locale.ROOT)+"  ");
      assertThat(http.error(blocked,429)).isEqualTo("RATE_LIMITED");
      assertThat(Integer.parseInt(blocked.headers().firstValue("Retry-After").orElseThrow())).isBetween(1,900);
      assertThat(jdbc.queryForObject("SELECT subject FROM studymate.request_limits WHERE bucket='login-email'",String.class))
          .hasSize(64).doesNotContain("@",email);
    }
  }

  @Test void concurrentInstancesCannotExceedOneAccountBudgetAndRestartDoesNotResetIt() throws Exception {
    UUID owner=UUID.randomUUID();
    var gate=new CountDownLatch(1);
    var replica=new PilotLimits(client,settings,transactions);
    try(var executor=Executors.newFixedThreadPool(8)) {
      var futures=new ArrayList<java.util.concurrent.Future<Boolean>>();
      for(int i=0;i<40;i++) {
        var instance=i%2==0?limits:replica;
        futures.add(executor.submit(()->{gate.await();try{instance.accountRequest(owner);return true;}
          catch(ApiException denied){assertThat(denied.response().error().code()).isEqualTo("RATE_LIMITED");return false;}}));
      }
      gate.countDown();int accepted=0;
      for(var future:futures) if(future.get(20,TimeUnit.SECONDS)) accepted++;
      assertThat(accepted).isEqualTo(30);
    }
    assertThatThrownBy(()->new PilotLimits(client,settings,transactions).accountRequest(owner)).isInstanceOf(ApiException.class);
    limits.accountRequest(UUID.randomUUID());
    jdbc.update("UPDATE studymate.request_limits SET expires_at=clock_timestamp()-interval '1 second' WHERE subject=?",owner.toString());
    replica.accountRequest(owner);
    assertThat(jdbc.queryForObject("SELECT used FROM studymate.request_limits WHERE bucket='account-api' AND subject=?",Integer.class,owner.toString())).isEqualTo(1);
  }

  @Test void quotaAndJobCreationRollBackTogether() {
    var tx=new TransactionTemplate(transactions);
    UUID owner=UUID.randomUUID();
    assertThatThrownBy(()->tx.execute(status->{limits.aiGeneration(owner);throw new IllegalStateException("simulated insert failure");}))
        .isInstanceOf(IllegalStateException.class);
    assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.request_limits",Integer.class)).isZero();
    assertThatThrownBy(()->limits.aiGeneration(owner)).isInstanceOf(org.springframework.transaction.IllegalTransactionStateException.class);
  }

  @Test void aiBudgetIsSharedBySummaryAndQuizAndIdempotentReplayDoesNotSpendAgain() throws Exception {
    try(var http=new AuthHttpClient(port)) {
      String email="generation-"+UUID.randomUUID()+"@example.com";
      UUID owner=UUID.fromString(http.register(email));http.data(http.login(email),200);http.csrf();
      UUID material=readyMaterial(owner);
      String key=UUID.randomUUID().toString();
      var summary=http.data(http.send("POST","/materials/"+material+"/summary",null,http.token,Map.of("Idempotency-Key",key)),202);
      assertThat(http.data(http.send("POST","/materials/"+material+"/summary",null,http.token,Map.of("Idempotency-Key",key)),202)).isEqualTo(summary);
      http.data(http.send("POST","/materials/"+material+"/quizzes",null,http.token,Map.of("Idempotency-Key",UUID.randomUUID().toString())),202);
      int jobsBefore=jdbc.queryForObject("SELECT count(*) FROM studymate.jobs WHERE kind IN ('material.summary','material.quiz') AND owner_id=?",Integer.class,owner);
      UUID another=readyMaterial(owner);
      var rejected=http.send("POST","/materials/"+another+"/summary",null,http.token,Map.of("Idempotency-Key",UUID.randomUUID().toString()));
      assertThat(http.error(rejected,429)).isEqualTo("RATE_LIMITED");
      assertThat(Integer.parseInt(rejected.headers().firstValue("Retry-After").orElseThrow())).isBetween(1,86400);
      assertThat(jdbc.queryForObject("SELECT used FROM studymate.request_limits WHERE bucket='ai-global'",Integer.class)).isEqualTo(2);
      assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.jobs WHERE kind IN ('material.summary','material.quiz') AND owner_id=?",Integer.class,owner)).isEqualTo(jobsBefore);
      // A second owner can consume the remaining global allowance, a third cannot.
      var tx=new TransactionTemplate(transactions);
      tx.executeWithoutResult(status->limits.aiGeneration(UUID.randomUUID()));
      assertThatThrownBy(()->tx.executeWithoutResult(status->limits.aiGeneration(UUID.randomUUID()))).isInstanceOf(ApiException.class);
      // Exhausting generation does not block reads or same-key recovery.
      http.data(http.send("GET","/materials/"+material+"/summary",null,null),200);
      assertThat(http.data(http.send("POST","/materials/"+material+"/summary",null,http.token,Map.of("Idempotency-Key",key)),202)).isEqualTo(summary);
    }
  }

  @Test void cleanupRemovesOnlyExpiredWindows() {
    limits.accountRequest(UUID.randomUUID());
    jdbc.update("INSERT INTO studymate.request_limits VALUES ('login-email',?,1,clock_timestamp()-interval '2 hours')","a".repeat(64));
    limits.cleanup();
    assertThat(jdbc.queryForObject("SELECT count(*) FROM studymate.request_limits",Integer.class)).isEqualTo(1);
  }

  private UUID readyMaterial(UUID owner) {
    UUID subject=UUID.randomUUID(), material=UUID.randomUUID();
    jdbc.update("INSERT INTO studymate.subjects(id,owner_id,title,normalized_title,description,normalized_description,icon,tone) VALUES (?,?,'Fixture',?,'','','book','blue')",subject,owner,subject.toString());
    jdbc.update("INSERT INTO studymate.material_objects(id,owner_id,request_key,fingerprint,object_key,size_bytes,sha256,state,accounting,response_body) VALUES (?,?,?,?,?,100,?,'stored','used','{}')",
        material,owner,UUID.randomUUID(),"a".repeat(64),"synthetic/"+material,"b".repeat(64));
    jdbc.update("INSERT INTO studymate.materials(id,owner_id,subject_id,title,normalized_title,file_name) VALUES (?,?,?,'Fixture','fixture','fixture.pdf')",material,owner,subject);
    UUID extracted=jobs.enqueue(owner,"material.extract_text",UUID.randomUUID(),json.valueToTree(Map.of("materialId",material)),RetryPolicy.SAFE);
    jdbc.update("UPDATE studymate.jobs SET status='succeeded',next_attempt_at=NULL,finished_at=clock_timestamp(),result_id=? WHERE id=?",material,extracted);
    jdbc.update("UPDATE studymate.materials SET processing_job_id=? WHERE id=?",extracted,material);
    return material;
  }
}
