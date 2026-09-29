package com.studymate.materials;

import com.studymate.jobs.*;
import com.studymate.materials.pdf.*;
import java.util.UUID;

class MaterialTextHandler implements JobHandler {
  private final MaterialTextRepository repository;
  private final ObjectStorage storage;
  private final PdfProcess parser;
  MaterialTextHandler(MaterialTextRepository repository,ObjectStorage storage,PdfProcess parser) {
    this.repository=repository; this.storage=storage; this.parser=parser;
  }
  public String kind() { return MaterialTextRepository.KIND; }
  public JobOutcome execute(JobLease lease) throws Exception {
    UUID id=UUID.fromString(lease.payload().get("materialId").asString());
    var current=repository.original(lease.ownerId(),id,false);
    if(current.isEmpty() || !lease.id().equals(current.get().job())) return new JobOutcome.Succeeded(() -> null);
    try(var workspace=new PdfWorkspace()) {
      var original=current.get();
      storage.fetch(original.key(),workspace.input(),original.bytes(),original.sha256());
      if(Thread.currentThread().isInterrupted()) throw new InterruptedException();
      var result=parser.extract(workspace.input(),workspace.directory());
      if(result.error()!=null) return new JobOutcome.Failed(JobError.valueOf(result.error()));
      return new JobOutcome.Succeeded(() -> repository.save(lease.ownerId(),id,lease.id(),result));
    } catch(ObjectIntegrityFailure failure) { return new JobOutcome.Failed(JobError.PDF_ORIGINAL_MISMATCH); }
    catch(StorageFailure failure) { return new JobOutcome.Retry(JobError.JOB_TEMPORARY_FAILURE); }
    catch(java.io.IOException failure) { return new JobOutcome.Failed(JobError.PDF_WORKER_FAILED); }
  }
}
