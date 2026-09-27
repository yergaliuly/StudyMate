package com.studymate.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import java.util.stream.Stream;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.transaction.TransactionSystemException;
import tools.jackson.databind.json.JsonMapper;

class SessionConfigurationTest {
  @ParameterizedTest
  @MethodSource("databaseFailures")
  void databaseFailureOutsideMvcUsesSafeJsonAndNeverReturnsPartialSuccess(RuntimeException failure) throws Exception {
    var filter = new SessionConfiguration().sessionDatabaseErrors(JsonMapper.builder().build()).getFilter();
    var response = new MockHttpServletResponse();
    filter.doFilter(new MockHttpServletRequest(), response, (request, output) -> {
      output.getWriter().write("partial private response");
      throw failure;
    });
    assertThat(response.getStatus()).isEqualTo(503);
    assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
    assertThat(response.getContentAsString()).contains("SERVICE_UNAVAILABLE").doesNotContain("private", "SQL");
  }

  static Stream<RuntimeException> databaseFailures() {
    return Stream.of(new DataAccessResourceFailureException("private SQL/credentials"),
        new CannotCreateTransactionException("private connection details"),
        new TransactionSystemException("private rollback details"));
  }

  @Test
  void alreadyCommittedResponseCannotBeReplacedByMisleadingJsonSuccess() {
    var filter = new SessionConfiguration().sessionDatabaseErrors(JsonMapper.builder().build()).getFilter();
    var response = new MockHttpServletResponse();
    assertThatThrownBy(() -> filter.doFilter(new MockHttpServletRequest(), response, (request, output) -> {
      output.flushBuffer();
      throw new DataAccessResourceFailureException("unavailable");
    })).isInstanceOf(DataAccessResourceFailureException.class);
  }
}
