package com.studymate.jobs;

import jakarta.annotation.PreDestroy;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(prefix = "studymate.jobs", name = "enabled", havingValue = "true", matchIfMissing = true)
class JobWorker implements AutoCloseable {
  private static final Logger log = LoggerFactory.getLogger(JobWorker.class);
  private final JobRepository jobs;
  private final JobCompletion completion;
  private final JobProperties settings;
  private final Map<String, JobHandler> handlers;
  private final ScheduledExecutorService control = Executors.newScheduledThreadPool(2,
      Thread.ofPlatform().daemon(true).name("studymate-jobs-control-", 0).factory());
  private final ExecutorService executor = Executors.newSingleThreadExecutor(
      Thread.ofPlatform().daemon(true).name("studymate-jobs-execution-", 0).factory());
  private final AtomicReference<Execution> active = new AtomicReference<>();
  private final AtomicBoolean started = new AtomicBoolean();
  private final AtomicBoolean stopped = new AtomicBoolean();

  JobWorker(JobRepository jobs, JobCompletion completion, JobProperties settings, List<JobHandler> handlers) {
    this.jobs = jobs; this.completion = completion; this.settings = settings;
    var registry = new HashMap<String, JobHandler>();
    for (var handler : handlers) {
      if (handler.kind() == null || !handler.kind().matches("[a-z][a-z0-9_.-]{0,79}")
          || registry.putIfAbsent(handler.kind(), handler) != null) {
        throw new IllegalArgumentException("Job handler kinds must be valid and unique");
      }
    }
    this.handlers = Map.copyOf(registry);
  }

  @EventListener(ApplicationReadyEvent.class)
  public void start() {
    if (stopped.get() || !started.compareAndSet(false, true)) return;
    control.scheduleWithFixedDelay(this::poll, 0, settings.pollIntervalMs(), TimeUnit.MILLISECONDS);
    // Wake cheaply; touch DB only when this execution needs renewal. Old queued jobs may have
    // a shorter persisted lease than today's configuration, so their heartbeat must adapt.
    control.scheduleWithFixedDelay(this::heartbeat, 100, 100, TimeUnit.MILLISECONDS);
  }

  private void poll() {
    if (stopped.get()) return;
    try {
      jobs.recoverExpired();
      if (active.get() != null) return;
      jobs.claim(handlers.keySet()).ifPresent(lease -> {
        var execution = new Execution(lease);
        active.set(execution);
        executor.execute(() -> execute(execution));
      });
    } catch (Exception exception) { safeLog("poll", exception); }
  }

  private void heartbeat() {
    var execution = active.get();
    if (execution == null || stopped.get() || execution.revoked.get() || System.nanoTime() < execution.nextHeartbeat) return;
    execution.nextHeartbeat = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(
        Math.min(settings.heartbeatIntervalMs(), execution.lease.leaseSeconds() * 1000 / 3));
    try {
      if (!jobs.renew(execution.lease)) execution.revoke();
    } catch (Exception exception) {
      // Do not continue side effects when ownership cannot be established.
      execution.revoke();
      safeLog("heartbeat", exception);
    }
  }

  private void execute(Execution execution) {
    execution.thread = Thread.currentThread();
    try {
      if (execution.revoked.get() || stopped.get()) return;
      JobOutcome outcome;
      try { outcome = Objects.requireNonNull(handlers.get(execution.lease.kind()).execute(execution.lease)); }
      catch (Exception exception) {
        if (execution.revoked.get() || stopped.get()) return;
        safeLog("execute", exception);
        outcome = new JobOutcome.Failed(execution.lease.retryPolicy() == RetryPolicy.MANUAL
            ? JobError.JOB_OUTCOME_UNKNOWN : JobError.JOB_PROCESSING_FAILED);
      }
      if (!execution.revoked.get() && !stopped.get()) completion.finish(execution.lease, outcome);
    } catch (JobCompletion.LostLeaseException ignored) {
      // Transaction rolled back; a newer owner (or recovery) now decides the job's state.
    } catch (Exception exception) {
      // Leave the lease for bounded recovery; never acknowledge an uncommitted result.
      safeLog("complete", exception);
    } finally {
      // Keep the slot occupied until the handler actually exits, even if it ignores interruption.
      active.compareAndSet(execution, null);
    }
  }

  private static void safeLog(String phase, Exception exception) {
    log.warn("Job worker failure (phase={}, type={})", phase, exception.getClass().getSimpleName());
  }

  @Override @PreDestroy
  public void close() {
    if (!stopped.compareAndSet(false, true)) return;
    control.shutdownNow();
    var execution = active.get();
    if (execution != null) execution.revoke();
    executor.shutdownNow();
    // A stopped process does not release uncertain work for immediate replay. The lease expires in DB.
    try { executor.awaitTermination(5, TimeUnit.SECONDS); }
    catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
  }

  private static final class Execution {
    private final JobLease lease;
    private final AtomicBoolean revoked = new AtomicBoolean();
    private volatile Thread thread;
    private long nextHeartbeat;
    private Execution(JobLease lease) { this.lease = lease; }
    private void revoke() {
      revoked.set(true);
      var running = thread;
      if (running != null) running.interrupt();
    }
  }
}
