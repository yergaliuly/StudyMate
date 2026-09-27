package com.studymate.identity;

import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.password.DelegatingPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(RegistrationConfiguration.RegistrationProperties.class)
public class RegistrationConfiguration {
  @ConfigurationProperties("studymate.registration")
  public record RegistrationProperties(boolean enabled) {}

  @Bean
  PasswordEncoder passwordEncoder() {
    // OWASP Argon2id minimum: 19 MiB, two iterations, one lane; independent random salt per hash.
    var argon2 = new Argon2PasswordEncoder(16, 32, 1, 19456, 2);
    return new DelegatingPasswordEncoder("argon2id", Map.of("argon2id", argon2));
  }
}
