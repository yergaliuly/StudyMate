package com.studymate.common.api;

import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;
import tools.jackson.databind.exc.MismatchedInputException;

@RestControllerAdvice
public class ApiExceptionHandler extends ResponseEntityExceptionHandler {
  private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

  @Override
  protected ResponseEntity<Object> handleMethodArgumentNotValid(
      MethodArgumentNotValidException exception, HttpHeaders headers,
      HttpStatusCode status, WebRequest request) {
    Map<String, String> fields = new LinkedHashMap<>();
    exception.getBindingResult().getFieldErrors().forEach(error ->
        fields.putIfAbsent(error.getField(), error.getDefaultMessage() == null
            ? "Недопустимое значение." : error.getDefaultMessage()));
    return handleExceptionInternal(exception,
        ApiErrorResponse.of("VALIDATION_FAILED", "Проверь поля формы.", fields),
        headers, HttpStatus.UNPROCESSABLE_CONTENT, request);
  }

  @Override
  protected ResponseEntity<Object> handleHttpMessageNotReadable(
      HttpMessageNotReadableException exception, HttpHeaders headers,
      HttpStatusCode status, WebRequest request) {
    // Jackson's messages may contain input, class names and internal paths.
    for (Throwable cause = exception.getCause(); cause != null; cause = cause.getCause()) {
      if (cause instanceof MismatchedInputException) {
        return handleExceptionInternal(exception, ApiErrors.forStatus(422), headers,
            HttpStatus.UNPROCESSABLE_CONTENT, request);
      }
    }
    return handleExceptionInternal(exception,
        ApiErrorResponse.of("MALFORMED_JSON", "Проверь формат JSON."),
        headers, HttpStatus.BAD_REQUEST, request);
  }

  @Override
  protected ResponseEntity<Object> handleExceptionInternal(
      Exception exception, Object body, HttpHeaders headers,
      HttpStatusCode status, WebRequest request) {
    HttpHeaders safeHeaders = new HttpHeaders();
    safeHeaders.putAll(headers);
    safeHeaders.setContentType(MediaType.APPLICATION_JSON);
    safeHeaders.setCacheControl("no-store");
    Object safeBody = body instanceof ApiErrorResponse ? body : ApiErrors.forStatus(status.value());
    return super.handleExceptionInternal(exception, safeBody, safeHeaders, status, request);
  }

  @ExceptionHandler(DataAccessResourceFailureException.class)
  ResponseEntity<Object> databaseUnavailable(DataAccessResourceFailureException exception, WebRequest request) {
    return handleExceptionInternal(exception, ApiErrors.forStatus(503), new HttpHeaders(),
        HttpStatus.SERVICE_UNAVAILABLE, request);
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<Object> unexpected(Exception exception, WebRequest request) {
    // Do not log request bodies, exception messages or SQL containing private data.
    log.error("Unhandled request failure (type={})", exception.getClass().getName());
    return handleExceptionInternal(exception, ApiErrors.forStatus(500), new HttpHeaders(),
        HttpStatus.INTERNAL_SERVER_ERROR, request);
  }
}
