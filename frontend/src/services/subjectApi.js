import { apiClient, ApiError } from './apiClient.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ICONS = ['book', 'database', 'languages', 'code'];
const TONES = ['blue', 'purple', 'indigo', 'green'];
const EDITABLE_FIELDS = ['title', 'description', 'icon', 'tone'];

function isVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

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

function toSubjectView(dto, status, { allowMissingVersion = false } = {}) {
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
    !Number.isFinite(Date.parse(dto.createdAt)) ||
    ((!allowMissingVersion || Object.hasOwn(dto, 'version')) && !isVersion(dto.version))
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
    // Старый сохранённый ответ POST может не иметь версии. Не выдумываем её:
    // перед редактированием вызывающий код должен загрузить актуальный GET.
    ...(Object.hasOwn(dto, 'version') ? { version: dto.version } : {}),
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

function updateBody(values, version) {
  if (!isVersion(version)) {
    throw new RangeError('version должна быть положительным безопасным целым числом.');
  }

  if (!isRecord(values)) {
    throw new TypeError('Изменения предмета должны быть объектом.');
  }

  const body = { version };

  for (const field of EDITABLE_FIELDS) {
    if (!Object.hasOwn(values, field)) continue;
    const value = requireString(values[field], field);
    body[field] = field === 'title'
      ? value.trim().replace(/\s+/g, ' ')
      : field === 'description' ? value.trim() : value;
  }

  if (Object.keys(body).length === 1) {
    throw new RangeError('Передай хотя бы одно изменяемое поле предмета.');
  }

  return body;
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

    return toSubjectView(result.data, result.status, { allowMissingVersion: true });
  }

  async function update(id, values, { version, signal } = {}) {
    const subjectId = requireUuid(id, 'id');
    const result = await client.request(`/subjects/${subjectId}`, {
      method: 'PATCH',
      body: updateBody(values, version),
      signal,
    });

    if (result.status !== 200) {
      throw invalidResponse(result.status);
    }

    const subject = toSubjectView(result.data, result.status);
    if (
      subject.id.toLowerCase() !== subjectId.toLowerCase() ||
      subject.version !== version + 1
    ) {
      throw invalidResponse(result.status);
    }

    return subject;
  }

  async function remove(id, { signal } = {}) {
    const subjectId = requireUuid(id, 'id');
    const result = await client.request(`/subjects/${subjectId}`, {
      method: 'DELETE',
      signal,
    });

    if (result.status !== 204) {
      throw invalidResponse(result.status);
    }
  }

  return {
    list,
    getById,
    create,
    update,
    remove,
  };
}

// Не делает запросов при импорте, не читает localStorage или mocks.
export const subjectApi = createSubjectApi();
