package com.studymate.materials;

final class ObjectIntegrityFailure extends RuntimeException {
  ObjectIntegrityFailure() { super("Original integrity check failed"); }
}
