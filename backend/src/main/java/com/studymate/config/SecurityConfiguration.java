package com.studymate.config;

import com.studymate.common.api.ApiErrorResponse;
import com.studymate.common.api.ApiErrors;
import com.studymate.common.api.ApiErrorWriter;
import com.studymate.materials.ObjectStorage;
import com.studymate.materials.UploadGateFilter;
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
import org.springframework.security.web.csrf.XorCsrfTokenRequestAttributeHandler;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
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
      HttpSessionCsrfTokenRepository tokens, SecurityContextRepository contexts, ObjectStorage storage) throws Exception {
    var xorCsrf = new XorCsrfTokenRequestAttributeHandler();
    var headerCsrf = new org.springframework.security.web.csrf.CsrfTokenRequestHandler() {
      @Override public void handle(jakarta.servlet.http.HttpServletRequest request,
          jakarta.servlet.http.HttpServletResponse response,
          java.util.function.Supplier<org.springframework.security.web.csrf.CsrfToken> token) {
        xorCsrf.handle(request, response, token);
      }
      @Override public String resolveCsrfTokenValue(jakarta.servlet.http.HttpServletRequest request,
          org.springframework.security.web.csrf.CsrfToken token) {
        // Never fall back to form/query parameters: that would parse an untrusted multipart body before authorization.
        return request.getHeader(token.getHeaderName()) == null ? null : xorCsrf.resolveCsrfTokenValue(request, token);
      }
    };
    http.authorizeHttpRequests(authorize -> authorize
            .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
            .requestMatchers(HttpMethod.GET, "/actuator/health", "/api/v1/auth/csrf").permitAll()
            .requestMatchers(HttpMethod.POST, "/api/v1/auth/register", "/api/v1/auth/login",
                "/api/v1/auth/logout").permitAll()
            .requestMatchers(HttpMethod.GET, "/api/v1/auth/me").authenticated()
            .requestMatchers(HttpMethod.GET, "/api/v1/subjects").authenticated()
            .requestMatchers(HttpMethod.POST, "/api/v1/subjects").authenticated()
            .requestMatchers(HttpMethod.GET, "/api/v1/subjects/*").authenticated()
            .requestMatchers(HttpMethod.PATCH, "/api/v1/subjects/*").authenticated()
            .requestMatchers(HttpMethod.DELETE, "/api/v1/subjects/*").authenticated()
            .requestMatchers(HttpMethod.GET, "/api/v1/jobs/*").authenticated()
            .requestMatchers(HttpMethod.GET, "/api/v1/materials", "/api/v1/materials/*",
                "/api/v1/materials/*/download", "/api/v1/materials/*/pages",
                "/api/v1/materials/*/summary", "/api/v1/storage/usage").authenticated()
            .requestMatchers(HttpMethod.POST, "/api/v1/materials", "/api/v1/materials/*/process",
                "/api/v1/materials/*/summary").authenticated()
            .requestMatchers(HttpMethod.PATCH, "/api/v1/materials/*", "/api/v1/materials/*/summary").authenticated()
            .requestMatchers(HttpMethod.DELETE, "/api/v1/materials/*").authenticated()
            .anyRequest().denyAll())
        .securityContext(context -> context.securityContextRepository(contexts))
        .csrf(csrf -> csrf.csrfTokenRepository(tokens).csrfTokenRequestHandler(headerCsrf))
        .addFilterAfter(new UploadGateFilter(storage, mapper), AuthorizationFilter.class)
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
