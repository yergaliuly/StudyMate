import { apiClient, ApiError } from './apiClient.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const INVALID_TEXT = /[\u0000-\u001f\u007f\ud800-\udfff]/u;
const STATUSES = new Set(['uploading', 'stored', 'deleting']);

const PROCESSING_STATUSES = new Set([
  'not_started', 'queued', 'running', 'ready', 'failed', 'cancelled',
]);

const PROCESSING_FIELDS = [
  'processingJobId', 'pageCount', 'textCharacters', 'processingError',
];

const PROCESSING_ERROR_CODES = new Set([
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

const MAX_PDF_PAGES = 200;
const MAX_PAGE_CHARACTERS = 100_000;
const MAX_DOCUMENT_CHARACTERS = 1_000_000;
const INVALID_PAGE_TEXT = /[\u0000\ud800-\udfff]/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function sameUuid(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isTimestamp(value) {
  return typeof value === 'string'
    && UTC_TIME.test(value)
    && Number.isFinite(Date.parse(value));
}

function isText(value, maxLength) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !INVALID_TEXT.test(value);
}

function requireUuid(value, field) {
  if (!isUuid(value)) throw new TypeError(field + ' должен быть UUID.');
  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(field + ' должен быть строкой.');
  }
  return value;
}

function normalizeTitle(value, allowEmpty = false) {
  const title = requireString(value, 'title').trim().replace(/\s+/g, ' ');

  if (
    title.length > 160
    || (!allowEmpty && title.length === 0)
    || INVALID_TEXT.test(title)
  ) {
    throw new RangeError('Название должно содержать от 1 до 160 допустимых символов.');
  }

  return title;
}

function invalidResponse(status) {
  return new ApiError(
    'Ответ сервера не соответствует контракту материалов.',
    { status, code: 'INVALID_RESPONSE' },
  );
}

function toMaterial(data, status, allowLegacyUpload = false) {
  if (
    !isRecord(data)
    || !isUuid(data.id)
    || !isUuid(data.subjectId)
    || !isText(data.title, 160)
    || !isText(data.fileName, 180)
    || !/\.pdf$/i.test(data.fileName)
    || data.contentType !== 'application/pdf'
    || !isPositiveInteger(data.sizeBytes)
    || !STATUSES.has(data.status)
    || !PROCESSING_STATUSES.has(data.processingStatus)
    || !isPositiveInteger(data.version)
    || !isTimestamp(data.createdAt)
    || !isTimestamp(data.updatedAt)
  ) {
    throw invalidResponse(status);
  }

  const validDeletionJob = data.status === 'deleting'
    ? isUuid(data.deletionJobId)
    : data.deletionJobId === null;

  if (!validDeletionJob) throw invalidResponse(status);

  const material = {
    id: data.id,
    subjectId: data.subjectId,
    title: data.title,
    fileName: data.fileName,
    contentType: data.contentType,
    sizeBytes: data.sizeBytes,
    status: data.status,
    processingStatus: data.processingStatus,
    version: data.version,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    deletionJobId: data.deletionJobId,
  };

  // Только исторический ответ upload может содержать прежние 12 полей.
  const legacyUpload = allowLegacyUpload
    && data.processingStatus === 'not_started'
    && PROCESSING_FIELDS.every((field) => !Object.hasOwn(data, field));

  if (legacyUpload) return material;

  if (PROCESSING_FIELDS.some((field) => !Object.hasOwn(data, field))) {
    throw invalidResponse(status);
  }

  const validProcessingJob = data.processingStatus === 'not_started'
    ? data.processingJobId === null
    : isUuid(data.processingJobId);

  const noText = data.pageCount === null && data.textCharacters === null;
  const hasText = isPositiveInteger(data.pageCount)
    && data.pageCount <= MAX_PDF_PAGES
    && isPositiveInteger(data.textCharacters)
    && data.textCharacters <= MAX_DOCUMENT_CHARACTERS
    && data.textCharacters <= data.pageCount * MAX_PAGE_CHARACTERS;

  const validError = data.processingStatus === 'failed'
    ? isRecord(data.processingError)
      && PROCESSING_ERROR_CODES.has(data.processingError.code)
      && typeof data.processingError.message === 'string'
      && data.processingError.message.trim().length > 0
    : data.processingError === null;

  if (
    !validProcessingJob
    || (!noText && !hasText)
    || (data.processingStatus === 'ready' && !hasText)
    || (data.processingStatus === 'not_started' && !noText)
    || !validError
  ) {
    throw invalidResponse(status);
  }

  // Хранение и обработка независимы: deleting может сохранять готовый текст.
  return {
    ...material,
    processingJobId: data.processingJobId,
    pageCount: data.pageCount,
    textCharacters: data.textCharacters,
    processingError: data.processingError === null
      ? null
      : {
          code: data.processingError.code,
          message: data.processingError.message,
        },
  };
}

function readMaterial(result, expectedStatus, allowLegacyUpload = false) {
  if (result.status !== expectedStatus) {
    throw invalidResponse(result.status);
  }

  return toMaterial(result.data, result.status, allowLegacyUpload);
}

function readOperation(result, requestedId) {
  const data = result.data;

  if (
    result.status !== 202
    || !isRecord(data)
    || !isUuid(data.materialId)
    || !sameUuid(data.materialId, requestedId)
    || !isUuid(data.jobId)
  ) {
    throw invalidResponse(result.status);
  }

  return { materialId: data.materialId, jobId: data.jobId };
}

function isDownloadUrl(value) {
  if (
    typeof value !== 'string'
    || !/^https:\/\//i.test(value)
    || /[\\\u0000-\u0020\u007f]/.test(value)
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !url.hash;
  } catch {
    return false;
  }
}

export function createMaterialApi(client = apiClient) {
  async function list({
    subjectId,
    q = '',
    page = 1,
    pageSize = 20,
    signal,
  } = {}) {
    const filterId = subjectId === undefined
      ? undefined
      : requireUuid(subjectId, 'subjectId');
    const query = requireString(q, 'q').trim();

    if (
      query.length > 160
      || INVALID_TEXT.test(query)
      || !isPositiveInteger(page)
      || !isPositiveInteger(pageSize)
      || pageSize > 100
    ) {
      throw new RangeError('Некорректные параметры поиска или страницы.');
    }

    const result = await client.request('/materials', {
      method: 'GET',
      query: {
        subjectId: filterId,
        q: query || undefined,
        page,
        pageSize,
      },
      signal,
    });

    const { data, meta, status } = result;
    if (
      status !== 200
      || !Array.isArray(data)
      || !isRecord(meta)
      || meta.page !== page
      || meta.pageSize !== pageSize
      || !Number.isSafeInteger(meta.total)
      || meta.total < 0
      || data.length > pageSize
      || data.length > meta.total
    ) {
      throw invalidResponse(status);
    }

    const materials = data.map((item) => toMaterial(item, status));
    if (
      filterId !== undefined
      && materials.some((item) => !sameUuid(item.subjectId, filterId))
    ) {
      throw invalidResponse(status);
    }

    return {
      materials,
      meta: { page: meta.page, pageSize: meta.pageSize, total: meta.total },
    };
  }

  async function getById(id, { signal } = {}) {
    requireUuid(id, 'id');
    const result = await client.request('/materials/' + id, {
      method: 'GET',
      signal,
    });

    const material = readMaterial(result, 200);
    if (!sameUuid(material.id, id)) throw invalidResponse(result.status);
    return material;
  }

  async function upload(values, { idempotencyKey, signal } = {}) {
    const key = requireUuid(idempotencyKey, 'Idempotency-Key');
    const subjectId = requireUuid(values?.subjectId, 'subjectId');

    if (typeof File === 'undefined' || !(values?.file instanceof File)) {
      throw new TypeError('Передай выбранный файл как объект File.');
    }

    const body = new FormData();
    body.append('file', values.file);
    body.append('subjectId', subjectId);

    if (values.title !== undefined) {
      body.append('title', normalizeTitle(values.title, true));
    }

    // Имя по умолчанию, содержимое PDF, размер и квоту проверяет сервер.
    // FormData сам задаёт Content-Type вместе с boundary.
    const result = await client.request('/materials', {
      method: 'POST',
      body,
      idempotencyKey: key,
      signal,
    });

    const material = readMaterial(result, 201, true);
    if (
      !sameUuid(material.subjectId, subjectId)
      || material.status !== 'stored'
    ) {
      throw invalidResponse(result.status);
    }

    // Повтор может вернуть прежний ответ: актуальность проверяется отдельным GET.
    return material;
  }

  async function rename(id, values, { version, signal } = {}) {
    requireUuid(id, 'id');
    if (!isPositiveInteger(version)) {
      throw new RangeError('version должна быть положительным безопасным целым числом.');
    }

    const result = await client.request('/materials/' + id, {
      method: 'PATCH',
      body: { title: normalizeTitle(values?.title), version },
      signal,
    });

    const material = readMaterial(result, 200);
    if (
      !sameUuid(material.id, id)
      || material.version !== version + 1
      || material.status !== 'stored'
    ) {
      throw invalidResponse(result.status);
    }

    return material;
  }

  async function getDownload(id, { signal } = {}) {
    requireUuid(id, 'id');
    const result = await client.request('/materials/' + id + '/download', {
      method: 'GET',
      signal,
    });

    const data = result.data;
    if (
      result.status !== 200
      || !isRecord(data)
      || !isDownloadUrl(data.url)
      || !isTimestamp(data.expiresAt)
    ) {
      throw invalidResponse(result.status);
    }

    // Ссылку не открываем, не кешируем и не пересобираем: сохраняем подпись.
    return { url: data.url, expiresAt: data.expiresAt };
  }

  async function remove(id, { signal } = {}) {
    requireUuid(id, 'id');
    const result = await client.request('/materials/' + id, {
      method: 'DELETE',
      signal,
    });

    return readOperation(result, id);
  }

  async function process(id, { idempotencyKey, signal } = {}) {
    requireUuid(id, 'id');
    const key = requireUuid(idempotencyKey, 'Idempotency-Key');

    const result = await client.request('/materials/' + id + '/process', {
      method: 'POST',
      idempotencyKey: key,
      signal,
    });

    // Только запуск или получение прежнего задания: без опроса и повторов.
    return readOperation(result, id);
  }

  async function pages(id, { page = 1, pageSize = 20, signal } = {}) {
    requireUuid(id, 'id');

    if (
      !isPositiveInteger(page)
      || !isPositiveInteger(pageSize)
      || pageSize > 100
    ) {
      throw new RangeError('Некорректные параметры страницы текста.');
    }

    const result = await client.request('/materials/' + id + '/pages', {
      method: 'GET',
      query: { page, pageSize },
      signal,
    });

    const { data, meta, status } = result;
    if (
      status !== 200
      || !Array.isArray(data)
      || !isRecord(meta)
      || meta.page !== page
      || meta.pageSize !== pageSize
      || !isPositiveInteger(meta.total)
      || meta.total > MAX_PDF_PAGES
    ) {
      throw invalidResponse(status);
    }

    // Сначала проверяем конец списка: огромный page не умножаем на pageSize.
    if (page > Math.ceil(meta.total / pageSize)) {
      if (data.length !== 0) throw invalidResponse(status);
      return {
        pages: [],
        meta: { page: meta.page, pageSize: meta.pageSize, total: meta.total },
      };
    }

    const offset = (page - 1) * pageSize;
    const expectedLength = Math.min(pageSize, meta.total - offset);
    if (data.length !== expectedLength) throw invalidResponse(status);

    let characters = 0;
    const textPages = data.map((item, index) => {
      if (
        !isRecord(item)
        || item.pageNumber !== offset + index + 1
        || typeof item.text !== 'string'
        || item.text.length > MAX_PAGE_CHARACTERS
        || INVALID_PAGE_TEXT.test(item.text)
      ) {
        throw invalidResponse(status);
      }

      characters += item.text.length;
      if (characters > MAX_DOCUMENT_CHARACTERS) {
        throw invalidResponse(status);
      }

      // Пустой текст, пробелы и переводы строк сохраняются без изменений.
      return { pageNumber: item.pageNumber, text: item.text };
    });

    return {
      pages: textPages,
      meta: { page: meta.page, pageSize: meta.pageSize, total: meta.total },
    };
  }

  return { list, getById, upload, rename, getDownload, remove, process, pages };
}

export const materialApi = createMaterialApi();