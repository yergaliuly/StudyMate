package com.studymate.jobs;

/** SAFE requires an idempotent operation. MANUAL never automatically repeats an uncertain execution. */
public enum RetryPolicy { SAFE, MANUAL }
