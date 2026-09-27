package com.studymate.common.api;

import java.lang.reflect.Type;
import java.util.Map;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpInputMessage;
import org.springframework.http.HttpStatus;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.RequestBodyAdviceAdapter;

@ControllerAdvice
public class JsonBodyAdvice extends RequestBodyAdviceAdapter {
  @Override
  public boolean supports(MethodParameter parameter, Type type,
      Class<? extends HttpMessageConverter<?>> converter) {
    return true;
  }

  @Override
  public Object afterBodyRead(Object body, HttpInputMessage input, MethodParameter parameter,
      Type type, Class<? extends HttpMessageConverter<?>> converter) {
    // A parsed JSON null is invalid input (422); absent or malformed JSON remains 400.
    if (body == null) {
      throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "VALIDATION_FAILED",
          "Передай объект с полями формы.", Map.of());
    }
    return body;
  }
}
