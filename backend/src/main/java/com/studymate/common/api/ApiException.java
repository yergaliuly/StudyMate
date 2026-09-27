package com.studymate.common.api;

import java.util.Map;
import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {
  private final HttpStatus status;
  private final ApiErrorResponse response;

  public ApiException(HttpStatus status, String code, String message, Map<String, String> fields) {
    super(code);
    this.status = status;
    this.response = ApiErrorResponse.of(code, message, fields);
  }

  public HttpStatus status() { return status; }

  public ApiErrorResponse response() { return response; }
}
