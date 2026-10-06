package com.studymate.identity;

import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.security.web.csrf.XorCsrfTokenRequestAttributeHandler;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/** MockMvc fixture with the real session repository, matching browser bootstrap semantics. */
public final class SessionCsrf {
  private SessionCsrf() {}
  public static Fixture csrf() { return new Fixture(); }
  public static RequestPostProcessor bootstrap(org.springframework.test.web.servlet.MockMvc mvc) throws Exception {
    var response = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/v1/auth/csrf"))
        .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk()).andReturn().getResponse();
    var cookie = response.getCookie("STUDYMATE_SESSION");
    org.assertj.core.api.Assertions.assertThat(cookie).isNotNull();
    String token = tools.jackson.databind.json.JsonMapper.builder().build()
        .readTree(response.getContentAsString()).at("/data/token").asString();
    return request -> { request.setCookies(cookie); request.addHeader("X-CSRF-TOKEN", token); return request; };
  }
  public static final class Fixture {
    private boolean invalid;
    public Fixture useInvalidToken() { invalid = true; return this; }
    public RequestPostProcessor asHeader() {
      return request -> {
        var repository = new HttpSessionCsrfTokenRepository();
        var response = new MockHttpServletResponse();
        var token = repository.generateToken(request);
        repository.saveToken(token, request, response);
        new XorCsrfTokenRequestAttributeHandler().handle(request, response, () -> token);
        var masked = (CsrfToken) request.getAttribute(CsrfToken.class.getName());
        request.addHeader(token.getHeaderName(), invalid ? "invalid-fixture" : masked.getToken());
        return request;
      };
    }
  }
}
