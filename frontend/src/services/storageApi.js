import { apiClient, ApiError } from './apiClient.js';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function invalidResponse(status) {
  return new ApiError(
    'Ответ сервера не соответствует контракту хранилища.',
    { status, code: 'INVALID_RESPONSE' },
  );
}

function readUsage(result) {
  const data = result.data;

  if (
    result.status !== 200
    || !isRecord(data)
    || !isNonnegativeInteger(data.usedBytes)
    || !isNonnegativeInteger(data.reservedBytes)
    || !Number.isSafeInteger(data.limitBytes)
    || data.limitBytes < 1
    || !Number.isSafeInteger(data.maxUploadBytes)
    || data.maxUploadBytes < 1
  ) {
    throw invalidResponse(result.status);
  }

  if (
    data.maxUploadBytes > data.limitBytes
    || data.usedBytes > data.limitBytes
    || data.reservedBytes > data.limitBytes - data.usedBytes
  ) {
    throw invalidResponse(result.status);
  }

  // Сохраняем отдельно занятое и зарезервированное место.
  // Лимиты берём из ответа сервера.
  return {
    usedBytes: data.usedBytes,
    reservedBytes: data.reservedBytes,
    limitBytes: data.limitBytes,
    maxUploadBytes: data.maxUploadBytes,
  };
}

export function createStorageApi(client = apiClient) {
  async function usage({ signal } = {}) {
    const result = await client.request('/storage/usage', {
      method: 'GET',
      signal,
    });

    return readUsage(result);
  }

  return { usage };
}

// Создание адаптера само по себе не отправляет запросы.
export const storageApi = createStorageApi();