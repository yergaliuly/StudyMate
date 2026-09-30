import { apiClient, ApiError } from './apiClient.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const STATUSES = new Set([
  'queued', 'running', 'succeeded', 'failed', 'cancelled',
]);

const TERMINAL_STATUSES = new Set([
  'succeeded', 'failed', 'cancelled',
]);

const ERROR_CODES = new Set([
  'JOB_TEMPORARY_FAILURE',
  'JOB_PROCESSING_FAILED',
  'JOB_ATTEMPTS_EXHAUSTED',
  'JOB_LEASE_EXPIRED',
  'JOB_OUTCOME_UNKNOWN',
  'PDF_INVALID',
  'PDF_ENCRYPTED',
  'PDF_NO_TEXT',
  'PDF_TOO_MANY_PAGES',
  'PDF_TEXT_LIMIT',
  'PDF_TIMEOUT',
  'PDF_RESOURCE_LIMIT',
  'PDF_WORKER_FAILED',
  'PDF_ORIGINAL_MISMATCH',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value) {
  return typeof value === 'string'
    && UTC_TIME.test(value)
    && Number.isFinite(Date.parse(value));
}

export function isTerminalJobStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function invalidResponse(status) {
  return new ApiError(
    'Ответ сервера не соответствует контракту заданий.',
    { status, code: 'INVALID_RESPONSE' },
  );
}

function readJob(result, requestedId) {
  const job = result.data;

  if (
    result.status !== 200
    || !isRecord(job)
    || !isUuid(job.id)
    || job.id.toLowerCase() !== requestedId.toLowerCase()
    || !isNonemptyString(job.type)
    || !STATUSES.has(job.status)
    || !Number.isSafeInteger(job.attemptCount)
    || job.attemptCount < 0
    || !Number.isSafeInteger(job.maxAttempts)
    || job.maxAttempts < 1
    || job.attemptCount > job.maxAttempts
    || !isTimestamp(job.createdAt)
    || !isTimestamp(job.updatedAt)
  ) {
    throw invalidResponse(result.status);
  }

  const validNextAttempt = job.status === 'queued'
    ? isTimestamp(job.nextAttemptAt)
    : job.nextAttemptAt === null;

  const validFinishedAt = isTerminalJobStatus(job.status)
    ? isTimestamp(job.finishedAt)
    : job.finishedAt === null;

  const validResult = job.status === 'succeeded'
    ? job.resultId === null || isUuid(job.resultId)
    : job.resultId === null;

  const validError = job.status === 'failed'
    ? isRecord(job.error)
      && ERROR_CODES.has(job.error.code)
      && isNonemptyString(job.error.message)
    : job.error === null;

  if (!validNextAttempt || !validFinishedAt || !validResult || !validError) {
    throw invalidResponse(result.status);
  }

  // Возвращаем только публичные поля, без внутренних данных backend.
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextAttemptAt: job.nextAttemptAt,
    finishedAt: job.finishedAt,
    resultId: job.resultId,
    error: job.error === null
      ? null
      : { code: job.error.code, message: job.error.message },
  };
}

export function createJobApi(client = apiClient) {
  async function getById(id, { signal } = {}) {
    if (!isUuid(id)) {
      throw new TypeError('ID задания должен быть UUID.');
    }

    const result = await client.request('/jobs/' + id, {
      method: 'GET',
      signal,
    });

    // failed — состояние задания, а не ошибка HTTP-запроса.
    return readJob(result, id);
  }

  return { getById };
}

export const jobApi = createJobApi();