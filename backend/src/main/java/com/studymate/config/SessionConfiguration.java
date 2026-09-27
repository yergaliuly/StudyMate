package com.studymate.config;

import com.studymate.common.api.ApiErrors;
import com.studymate.common.api.ApiErrorWriter;
import com.studymate.identity.SessionLifetimeFilter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DataAccessException;
import org.springframework.session.web.http.SessionRepositoryFilter;
import org.springframework.transaction.TransactionException;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

@Configuration(proxyBeanMethods = false)
public class SessionConfiguration {
  private static final Logger log = LoggerFactory.getLogger(SessionConfiguration.class);
  @Bean
  Clock clock() { return Clock.systemUTC(); }

  @Bean
  FilterRegistrationBean<SessionLifetimeFilter> sessionLifetimeFilter(Clock clock) {
    var registration = new FilterRegistrationBean<>(new SessionLifetimeFilter(clock));
    registration.setOrder(SessionRepositoryFilter.DEFAULT_ORDER + 1);
    return registration;
  }

  @Bean
  FilterRegistrationBean<OncePerRequestFilter> sessionDatabaseErrors(JsonMapper mapper) {
    // Session loading/saving happens outside MVC, so ControllerAdvice cannot handle these failures.
    var filter = new OncePerRequestFilter() {
      @Override
      protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
          FilterChain chain) throws ServletException, IOException {
        try {
          chain.doFilter(request, response);
        } catch (DataAccessException | TransactionException exception) {
          // JDBC session transactions may fail on begin/rollback as well as during the query.
          log.warn("Session database failure (type={})", exception.getClass().getSimpleName());
          if (response.isCommitted()) throw exception;
          response.reset();
          ApiErrorWriter.write(response, mapper, 503, ApiErrors.forStatus(503));
        }
      }
    };
    var registration = new FilterRegistrationBean<OncePerRequestFilter>(filter);
    registration.setOrder(SessionRepositoryFilter.DEFAULT_ORDER - 1);
    return registration;
  }
}
