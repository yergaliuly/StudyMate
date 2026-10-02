package com.studymate.jobs;

/** Only allowlisted messages may reach the job API; never persist exception/provider messages. */
public enum JobError {
  JOB_TEMPORARY_FAILURE("Временная ошибка обработки."),
  JOB_PROCESSING_FAILED("Не удалось выполнить задание."),
  JOB_ATTEMPTS_EXHAUSTED("Достигнут предел попыток выполнения."),
  JOB_LEASE_EXPIRED("Выполнение прервалось или превысило допустимое время."),
  JOB_OUTCOME_UNKNOWN("Результат выполнения неизвестен. Нужна проверка перед повтором."),
  PDF_INVALID("Не удалось прочитать структуру PDF."),
  PDF_ENCRYPTED("Зашифрованные PDF не поддерживаются. Загрузи копию без шифрования."),
  PDF_NO_TEXT("В PDF не найден текстовый слой. OCR пока не поддерживается."),
  PDF_TOO_MANY_PAGES("В PDF больше 200 страниц."),
  PDF_TEXT_LIMIT("Превышен предел текста: 100 000 символов на страницу или 1 000 000 на PDF."),
  PDF_TIMEOUT("Извлечение текста превысило 60 секунд."),
  PDF_RESOURCE_LIMIT("PDF требует больше памяти, чем разрешено обработчику."),
  PDF_WORKER_FAILED("Обработчик PDF завершился без корректного результата."),
  PDF_ORIGINAL_MISMATCH("Сохранённый оригинал не прошёл проверку целостности."),
  AI_UNAVAILABLE("Сервис генерации временно недоступен."),
  AI_INVALID_RESPONSE("Не удалось проверить ответ ИИ. Конспект не сохранён."),
  AI_OUTCOME_UNKNOWN("Результат платного вызова неизвестен. Автоматический повтор отключён.");

  private final String message;
  JobError(String message) { this.message = message; }
  public String message() { return message; }
}
