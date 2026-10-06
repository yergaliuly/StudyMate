package com.studymate.pilot;

import com.studymate.common.api.ApiErrorWriter;
import com.studymate.common.api.ApiErrors;
import com.studymate.common.api.ApiException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DataAccessException;
import org.springframework.session.web.http.SessionRepositoryFilter;
import org.springframework.transaction.TransactionException;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

@Configuration(proxyBeanMethods=false)
@EnableConfigurationProperties(PilotProperties.class)
class PilotConfiguration {
  @Bean
  FilterRegistrationBean<OncePerRequestFilter> authTrafficLimits(PilotLimits limits, JsonMapper mapper) {
    var filter = new OncePerRequestFilter() {
      @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
          throws ServletException, IOException {
        String path = request.getServletPath();
        String action = null;
        if ("GET".equals(request.getMethod()) && "/api/v1/auth/csrf".equals(path)) action = "csrf";
        if ("POST".equals(request.getMethod()) && "/api/v1/auth/login".equals(path)) action = "login";
        if ("POST".equals(request.getMethod()) && "/api/v1/auth/register".equals(path)) action = "register";
        if (action != null) {
          try { limits.authRequest(action); }
          catch (ApiException failure) {
            response.setHeader("Retry-After", failure.retryAfterSeconds().toString());
            ApiErrorWriter.write(response, mapper, failure.status().value(), failure.response()); return;
          } catch (DataAccessException | TransactionException failure) {
            ApiErrorWriter.write(response, mapper, 503, ApiErrors.forStatus(503)); return;
          }
        }
        chain.doFilter(request, response);
      }
    };
    var registration = new FilterRegistrationBean<OncePerRequestFilter>(filter);
    registration.setOrder(SessionRepositoryFilter.DEFAULT_ORDER-2);
    return registration;
  }
}
