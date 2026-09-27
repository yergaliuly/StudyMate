import { apiClient, ApiError } from './apiClient.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ICONS = ['book', 'database', 'languages', 'code'];
const TONES = ['blue', 'purple', 'indigo', 'green'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`${field} должен быть UUID.`);
  }

  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} должен быть строкой.`);
  }

  return value;
}

function invalidResponse(status) {
  return new ApiError(
    'Ответ сервера не соответствует контракту предметов.',
    { status, code: 'INVALID_RESPONSE' },
  );
}

function toSubjectView(dto, status) {
  if (
    !isRecord(dto) ||
    typeof dto.id !== 'string' || !UUID.test(dto.id) ||
    typeof dto.title !== 'string' ||
    dto.title.length < 2 || dto.title.length > 60 ||
    typeof dto.description !== 'string' || dto.description.length > 160 ||
    !ICONS.includes(dto.icon) || !TONES.includes(dto.tone) ||
    !Number.isSafeInteger(dto.lectureCount) || dto.lectureCount < 0 ||
    dto.progressPercent !== null ||
    typeof dto.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(dto.createdAt))
  ) {
    throw invalidResponse(status);
  }

  return {
    id: dto.id,
    title: dto.title,
    description: dto.description,
    icon: dto.icon,
    tone: dto.tone,
    lectures: dto.lectureCount,
    progress: dto.progressPercent,
    createdAt: dto.createdAt,
  };
}

function createBody(values) {
  // Явный список полей: владельца, ID и счётчики не отправляем.
  return {
    title: requireString(values?.title, 'title')
      .trim().replace(/\s+/g, ' '),

    description: requireString(
      values?.description === undefined ? '' : values.description,
      'description',
    ).trim(),

    icon: requireString(values?.icon, 'icon'),
    tone: requireString(values?.tone, 'tone'),
  };
}

export function createSubjectApi(client = apiClient) {
  async function list({
    q = '',
    page = 1,
    pageSize = 20,
    signal,
  } = {}) {
    const query = requireString(q, 'q').trim();

    if (
      query.length > 160 ||
      !Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    ) {
      throw new RangeError(
        'Некорректные параметры поиска или страницы.',
      );
    }

    const result = await client.request('/subjects', {
      query: {
        q: query || undefined,
        page,
        pageSize,
      },
      signal,
    });

    const { data, meta, status } = result;

    if (
      status !== 200 ||
      !Array.isArray(data) ||
      !isRecord(meta) ||
      meta.page !== page ||
      meta.pageSize !== pageSize ||
      !Number.isSafeInteger(meta.total) ||
      meta.total < 0 ||
      data.length > pageSize
    ) {
      throw invalidResponse(status);
    }

    return {
      subjects: data.map((item) => toSubjectView(item, status)),

      meta: {
        page: meta.page,
        pageSize: meta.pageSize,
        total: meta.total,
      },
    };
  }

  async function getById(id, { signal } = {}) {
    const subjectId = requireUuid(id, 'id');

    const result = await client.request(
      `/subjects/${subjectId}`,
      { signal },
    );

    if (result.status !== 200) {
      throw invalidResponse(result.status);
    }

    const subject = toSubjectView(result.data, result.status);

    if (subject.id.toLowerCase() !== subjectId.toLowerCase()) {
      throw invalidResponse(result.status);
    }

    return subject;
  }

  async function create(values, { idempotencyKey, signal } = {}) {
    const key = requireUuid(idempotencyKey, 'Idempotency-Key');

    const result = await client.request('/subjects', {
      method: 'POST',
      body: createBody(values),
      idempotencyKey: key,
      signal,
    });

    if (result.status !== 201) {
      throw invalidResponse(result.status);
    }

    return toSubjectView(result.data, result.status);
  }

  return {
    list,
    getById,
    create,
  };
}

// Не делает запросов при импорте, не читает localStorage или mocks.
export const subjectApi = createSubjectApi();