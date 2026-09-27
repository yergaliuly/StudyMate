package com.studymate.common.api;

import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.webmvc.error.ErrorController;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ApiErrorController implements ErrorController {
  @RequestMapping("/error")
  ResponseEntity<ApiErrorResponse> error(HttpServletRequest request) {
    Object attribute = request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
    int status = attribute instanceof Integer code && code >= 400 && code <= 599 ? code : 500;
    return ResponseEntity.status(status).cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON).body(ApiErrors.forStatus(status));
  }
}
