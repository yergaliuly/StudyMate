package com.studymate.common.api;

import java.util.Map;
import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {
  private final HttpStatus status;
  private final ApiErrorResponse response;
  private final Integer retryAfterSeconds;

  public ApiException(HttpStatus status, String code, String message, Map<String, String> fields) {
    this(status, code, message, fields, null);
  }

  public ApiException(HttpStatus status, String code, String message, Map<String, String> fields,
      Integer retryAfterSeconds) {
    super(code);
    this.status = status;
    this.response = ApiErrorResponse.of(code, message, fields);
    this.retryAfterSeconds = retryAfterSeconds;
  }

  public HttpStatus status() { return status; }

  public ApiErrorResponse response() { return response; }

  public Integer retryAfterSeconds() { return retryAfterSeconds; }
}
