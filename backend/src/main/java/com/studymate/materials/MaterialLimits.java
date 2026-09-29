package com.studymate.materials;

public final class MaterialLimits {
  public static final long MAX_UPLOAD_BYTES = 26_214_400;
  public static final long ACCOUNT_BYTES = 524_288_000;
  public static final long MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 65_536;
  private MaterialLimits() {}
}
