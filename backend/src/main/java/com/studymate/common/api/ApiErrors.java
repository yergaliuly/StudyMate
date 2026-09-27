package com.studymate.common.api;

public final class ApiErrors {
  private ApiErrors() {}

  public static ApiErrorResponse forStatus(int status) {
    return switch (status) {
      case 400 -> ApiErrorResponse.of("INVALID_REQUEST", "Проверь запрос.");
      case 401 -> ApiErrorResponse.of("AUTHENTICATION_REQUIRED", "Войди в аккаунт.");
      case 403 -> ApiErrorResponse.of("ACCESS_DENIED", "Доступ запрещён.");
      case 404 -> ApiErrorResponse.of("NOT_FOUND", "Ресурс не найден.");
      case 405 -> ApiErrorResponse.of("METHOD_NOT_ALLOWED", "Метод запроса не поддерживается.");
      case 406 -> ApiErrorResponse.of("NOT_ACCEPTABLE", "Запрошенный формат ответа не поддерживается.");
      case 413 -> ApiErrorResponse.of("PAYLOAD_TOO_LARGE", "Размер запроса превышает лимит.");
      case 415 -> ApiErrorResponse.of("UNSUPPORTED_MEDIA_TYPE", "Формат запроса не поддерживается.");
      case 422 -> ApiErrorResponse.of("VALIDATION_FAILED", "Проверь поля формы.");
      case 503 -> ApiErrorResponse.of("SERVICE_UNAVAILABLE", "Сервис временно недоступен.");
      default -> ApiErrorResponse.of("INTERNAL_ERROR", "Не удалось выполнить запрос.");
    };
  }
}
