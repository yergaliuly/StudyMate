package com.studymate.identity;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.ProviderManager;

@Configuration(proxyBeanMethods = false)
class AuthenticationConfiguration {
  @Bean
  AuthenticationManager authenticationManager(AccountAuthenticationProvider provider) {
    return new ProviderManager(provider);
  }
}
