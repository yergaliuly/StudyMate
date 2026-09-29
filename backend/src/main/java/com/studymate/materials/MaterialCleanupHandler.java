package com.studymate.materials;

import com.studymate.jobs.JobError;
import com.studymate.jobs.JobHandler;
import com.studymate.jobs.JobLease;
import com.studymate.jobs.JobOutcome;
import java.util.UUID;

class MaterialCleanupHandler implements JobHandler {
  private final MaterialRepository repository;
  private final ObjectStorage storage;
  MaterialCleanupHandler(MaterialRepository repository, ObjectStorage storage) { this.repository = repository; this.storage = storage; }
  public String kind() { return MaterialRepository.CLEANUP_KIND; }
  public JobOutcome execute(JobLease lease) {
    UUID id = UUID.fromString(lease.payload().get("materialId").asString());
    var object = repository.object(lease.ownerId(),id,false);
    if (!object.state().equals("deleting") || !lease.id().equals(object.jobId())) return new JobOutcome.Succeeded(() -> id);
    if (!object.ready()) return new JobOutcome.Retry(JobError.JOB_TEMPORARY_FAILURE);
    try { storage.delete(object.objectKey()); }
    catch (StorageFailure failure) { return new JobOutcome.Retry(JobError.JOB_TEMPORARY_FAILURE); }
    return new JobOutcome.Succeeded(() -> repository.finishCleanup(lease.ownerId(),id,lease.id()));
  }
}
