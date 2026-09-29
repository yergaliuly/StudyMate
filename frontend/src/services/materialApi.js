import { apiClient, ApiError } from './apiClient.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const INVALID_TEXT = /[\u0000-\u001f\u007f\ud800-\udfff]/u;
const STATUSES = new Set(['uploading', 'stored', 'deleting']);

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

function toMaterial(data, status) {
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
    || data.processingStatus !== 'not_started'
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

  return {
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
}

function readMaterial(result, expectedStatus) {
  if (result.status !== expectedStatus) {
    throw invalidResponse(result.status);
  }

  return toMaterial(result.data, result.status);
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

    const material = readMaterial(result, 201);
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

    const data = result.data;
    if (
      result.status !== 202
      || !isRecord(data)
      || !isUuid(data.materialId)
      || !sameUuid(data.materialId, id)
      || !isUuid(data.jobId)
    ) {
      throw invalidResponse(result.status);
    }

    // Это запуск очистки. Наблюдение за jobId подключается отдельно в UI.
    return { materialId: data.materialId, jobId: data.jobId };
  }

  return { list, getById, upload, rename, getDownload, remove };
}

export const materialApi = createMaterialApi();