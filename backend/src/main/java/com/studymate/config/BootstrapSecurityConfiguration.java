package com.studymate.config;

import com.studymate.common.api.ApiErrorResponse;
import com.studymate.common.api.ApiErrors;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CsrfException;
import tools.jackson.databind.json.JsonMapper;

@Configuration(proxyBeanMethods = false)
public class BootstrapSecurityConfiguration {
  @Bean
  SecurityFilterChain securityFilterChain(HttpSecurity http, JsonMapper mapper) throws Exception {
    // Registration remains CSRF-protected; the token endpoint is added in stage 4.
    http.authorizeHttpRequests(authorize -> authorize
            .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
            .requestMatchers(HttpMethod.GET, "/actuator/health").permitAll()
            .requestMatchers(HttpMethod.POST, "/api/v1/auth/register").permitAll()
            .anyRequest().denyAll())
        .csrf(Customizer.withDefaults())
        .formLogin(AbstractHttpConfigurer::disable)
        .httpBasic(AbstractHttpConfigurer::disable)
        .logout(AbstractHttpConfigurer::disable)
        .requestCache(AbstractHttpConfigurer::disable)
        .exceptionHandling(errors -> errors
            .authenticationEntryPoint((request, response, exception) ->
                writeError(response, mapper, 401, ApiErrors.forStatus(401)))
            .accessDeniedHandler((request, response, exception) ->
                writeError(response, mapper, 403, exception instanceof CsrfException
                    ? ApiErrorResponse.of("CSRF_INVALID", "Обнови страницу и повтори действие.")
                    : ApiErrors.forStatus(403))));
    return http.build();
  }

  private static void writeError(HttpServletResponse response, JsonMapper mapper,
      int status, ApiErrorResponse body) throws IOException {
    response.setStatus(status);
    response.setContentType(MediaType.APPLICATION_JSON_VALUE);
    response.setCharacterEncoding(StandardCharsets.UTF_8.name());
    response.setHeader("Cache-Control", "no-store");
    mapper.writeValue(response.getOutputStream(), body);
  }
}
