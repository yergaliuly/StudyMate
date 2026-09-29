package com.studymate.materials;

/** Deliberately does not retain SDK exceptions, which may contain private URLs/headers. */
public final class StorageFailure extends RuntimeException {
  public StorageFailure() { super("Private storage unavailable"); }
}
