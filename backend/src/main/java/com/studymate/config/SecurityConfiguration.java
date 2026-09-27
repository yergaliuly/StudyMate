package com.studymate.config;

import com.studymate.common.api.ApiErrorResponse;
import com.studymate.common.api.ApiErrors;
import com.studymate.common.api.ApiErrorWriter;
import jakarta.servlet.DispatcherType;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.session.ChangeSessionIdAuthenticationStrategy;
import org.springframework.security.web.authentication.session.CompositeSessionAuthenticationStrategy;
import org.springframework.security.web.authentication.session.SessionAuthenticationStrategy;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfAuthenticationStrategy;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import tools.jackson.databind.json.JsonMapper;

@Configuration(proxyBeanMethods = false)
public class SecurityConfiguration {
  @Bean
  HttpSessionCsrfTokenRepository csrfTokenRepository() {
    return new HttpSessionCsrfTokenRepository();
  }

  @Bean
  SecurityContextRepository securityContextRepository() {
    return new HttpSessionSecurityContextRepository();
  }

  @Bean
  SessionAuthenticationStrategy sessionAuthenticationStrategy(HttpSessionCsrfTokenRepository tokens) {
    // Controller login explicitly invokes both standard strategies before saving context.
    return new CompositeSessionAuthenticationStrategy(List.of(
        new ChangeSessionIdAuthenticationStrategy(), new CsrfAuthenticationStrategy(tokens)));
  }

  @Bean
  SecurityFilterChain securityFilterChain(HttpSecurity http, JsonMapper mapper,
      HttpSessionCsrfTokenRepository tokens, SecurityContextRepository contexts) throws Exception {
    http.authorizeHttpRequests(authorize -> authorize
            .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
            .requestMatchers(HttpMethod.GET, "/actuator/health", "/api/v1/auth/csrf").permitAll()
            .requestMatchers(HttpMethod.POST, "/api/v1/auth/register", "/api/v1/auth/login",
                "/api/v1/auth/logout").permitAll()
            .requestMatchers(HttpMethod.GET, "/api/v1/auth/me").authenticated()
            .anyRequest().denyAll())
        .securityContext(context -> context.securityContextRepository(contexts))
        .csrf(csrf -> csrf.csrfTokenRepository(tokens))
        .formLogin(AbstractHttpConfigurer::disable)
        .httpBasic(AbstractHttpConfigurer::disable)
        .logout(logout -> logout.logoutRequestMatcher(request ->
                "POST".equals(request.getMethod()) && "/api/v1/auth/logout".equals(request.getServletPath()))
            .logoutSuccessHandler((request, response, authentication) -> {
              response.setStatus(204);
              response.setHeader("Cache-Control", "no-store");
            }))
        .requestCache(AbstractHttpConfigurer::disable)
        .exceptionHandling(errors -> errors
            .authenticationEntryPoint((request, response, exception) ->
                ApiErrorWriter.write(response, mapper, 401, ApiErrors.forStatus(401)))
            .accessDeniedHandler((request, response, exception) ->
                ApiErrorWriter.write(response, mapper, 403, exception instanceof CsrfException
                    ? ApiErrorResponse.of("CSRF_INVALID", "Обнови страницу и повтори действие.")
                    : ApiErrors.forStatus(403))));
    return http.build();
  }
}
