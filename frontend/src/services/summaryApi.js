import { apiClient, ApiError } from './apiClient.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const INVALID_CONTENT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/u;
const INVALID_LABEL = /[\u0000-\u001f\u007f\ud800-\udfff]/u;
const STATUSES = new Set(['queued', 'running', 'ready', 'failed', 'cancelled']);
const ERROR_CODES = new Set([
  'JOB_TEMPORARY_FAILURE',
  'JOB_PROCESSING_FAILED',
  'JOB_ATTEMPTS_EXHAUSTED',
  'JOB_LEASE_EXPIRED',
  'JOB_OUTCOME_UNKNOWN',
  'AI_UNAVAILABLE',
  'AI_INVALID_RESPONSE',
  'AI_OUTCOME_UNKNOWN',
]);
const VERSION_FIELDS = [
  'version', 'content', 'sourcePages', 'origin', 'model',
  'inputTokens', 'outputTokens', 'createdAt',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function requireUuid(value, field) {
  if (!isUuid(value)) throw new TypeError(field + ' должен быть UUID.');
  return value;
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
}

function isTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

export function isValidSummaryContent(value) {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= 100_000 && !INVALID_CONTENT.test(value);
}

function validSavedVersion(data) {
  if (
    !Number.isSafeInteger(data.version) || data.version < 1
    || !isValidSummaryContent(data.content)
    || !isTimestamp(data.createdAt)
    || !Array.isArray(data.sourcePages) || data.sourcePages.length > 200
    || data.sourcePages.some((page, index, pages) => !Number.isSafeInteger(page)
      || page < 1 || page > 200 || (index > 0 && page <= pages[index - 1]))
  ) return false;

  if (data.origin === 'user') {
    return data.sourcePages.length === 0 && data.model === null
      && data.inputTokens === null && data.outputTokens === null;
  }

  return data.origin === 'ai' && data.sourcePages.length > 0
    && typeof data.model === 'string' && data.model.trim().length > 0
    && data.model.length <= 80 && !INVALID_LABEL.test(data.model)
    && isTokenCount(data.inputTokens) && isTokenCount(data.outputTokens);
}

function invalidResponse(status) {
  return new ApiError('Ответ сервера не соответствует контракту конспекта.', {
    status, code: 'INVALID_RESPONSE',
  });
}

function readSummary(result, requestedId) {
  const data = result.data;
  if (
    result.status !== 200 || !isRecord(data)
    || !isUuid(data.materialId)
    || data.materialId.toLowerCase() !== requestedId.toLowerCase()
    || !isUuid(data.jobId) || !STATUSES.has(data.status)
    || !isTimestamp(data.updatedAt)
  ) throw invalidResponse(result.status);

  const validVersion = data.version === null
    ? data.status !== 'ready' && VERSION_FIELDS.every((field) => data[field] === null)
    : validSavedVersion(data);
  const validError = data.status === 'failed'
    ? isRecord(data.error) && ERROR_CODES.has(data.error.code)
      && typeof data.error.message === 'string' && data.error.message.trim().length > 0
    : data.error === null;
  if (!validVersion || !validError) throw invalidResponse(result.status);

  // Не нормализуем текст и не выполняем HTML. Только публичные поля DTO.
  return {
    materialId: data.materialId,
    status: data.status,
    jobId: data.jobId,
    version: data.version,
    content: data.content,
    sourcePages: data.sourcePages === null ? null : [...data.sourcePages],
    origin: data.origin,
    model: data.model,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    error: data.error === null ? null : { code: data.error.code, message: data.error.message },
  };
}

export function createSummaryApi(client = apiClient) {
  async function getByMaterial(id, { signal } = {}) {
    requireUuid(id, 'materialId');
    return readSummary(await client.request('/materials/' + id + '/summary', {
      method: 'GET', signal,
    }), id);
  }

  async function generate(id, { idempotencyKey, signal } = {}) {
    requireUuid(id, 'materialId');
    const key = requireUuid(idempotencyKey, 'Idempotency-Key');
    const result = await client.request('/materials/' + id + '/summary', {
      method: 'POST', idempotencyKey: key, signal,
    });
    const data = result.data;
    if (result.status !== 202 || !isRecord(data) || !isUuid(data.materialId)
      || data.materialId.toLowerCase() !== id.toLowerCase() || !isUuid(data.jobId)) {
      throw invalidResponse(result.status);
    }
    // Ключ задаёт вызывающий код. Адаптер не повторяет генерацию и не опрашивает job.
    return { materialId: data.materialId, jobId: data.jobId };
  }

  async function update(id, values, { version, signal } = {}) {
    requireUuid(id, 'materialId');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new RangeError('version должна быть положительным безопасным целым числом.');
    }
    if (!isValidSummaryContent(values?.content)) {
      throw new RangeError('Конспект должен содержать от 1 до 100 000 допустимых символов.');
    }
    const result = await client.request('/materials/' + id + '/summary', {
      method: 'PATCH', body: { content: values.content, version }, signal,
    });
    const data = readSummary(result, id);
    if (data.version !== version + 1 || data.origin !== 'user'
      || !['ready', 'failed', 'cancelled'].includes(data.status)) {
      throw invalidResponse(result.status);
    }
    // Сервер может убрать крайние пробелы; исходный черновик не нормализуем.
    return data;
  }

  return { getByMaterial, generate, update };
}

export const summaryApi = createSummaryApi();
