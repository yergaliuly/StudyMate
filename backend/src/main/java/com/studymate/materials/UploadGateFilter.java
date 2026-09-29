package com.studymate.materials;

import com.studymate.common.api.ApiErrorResponse;
import com.studymate.common.api.ApiErrorWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.concurrent.Semaphore;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

/** Runs after authorization and header CSRF, before the servlet can create temporary files. */
public final class UploadGateFilter extends OncePerRequestFilter {
  private final Semaphore slots = new Semaphore(2);
  private final ObjectStorage storage;
  private final JsonMapper mapper;
  public UploadGateFilter(ObjectStorage storage, JsonMapper mapper) { this.storage = storage; this.mapper = mapper; }
  @Override protected boolean shouldNotFilter(HttpServletRequest request) {
    return !"POST".equals(request.getMethod()) || !"/api/v1/materials".equals(request.getServletPath());
  }
  @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws IOException, ServletException {
    if (!storage.enabled()) { error(response, 503, "STORAGE_UNAVAILABLE", "Хранилище файлов ещё не настроено."); return; }
    if (request.getContentLengthLong() > MaterialLimits.MAX_REQUEST_BYTES) {
      error(response, 413, "PAYLOAD_TOO_LARGE", "PDF должен быть не больше 26 214 400 байт."); return;
    }
    if (!slots.tryAcquire()) {
      response.setHeader("Retry-After", "2");
      error(response, 429, "UPLOAD_BUSY", "Повтори загрузку немного позже."); return;
    }
    try { chain.doFilter(request, response); } finally { slots.release(); }
  }
  private void error(HttpServletResponse response, int status, String code, String message) throws IOException {
    ApiErrorWriter.write(response, mapper, status, ApiErrorResponse.of(code, message));
  }
}
