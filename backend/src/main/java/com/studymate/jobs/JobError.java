package com.studymate.jobs;

/** Only allowlisted messages may reach the job API; never persist exception/provider messages. */
public enum JobError {
  JOB_TEMPORARY_FAILURE("Временная ошибка обработки."),
  JOB_PROCESSING_FAILED("Не удалось выполнить задание."),
  JOB_ATTEMPTS_EXHAUSTED("Достигнут предел попыток выполнения."),
  JOB_LEASE_EXPIRED("Выполнение прервалось или превысило допустимое время."),
  JOB_OUTCOME_UNKNOWN("Результат выполнения неизвестен. Нужна проверка перед повтором.");

  private final String message;
  JobError(String message) { this.message = message; }
  public String message() { return message; }
}
