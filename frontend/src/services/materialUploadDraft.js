import { ApiError } from './apiClient.js';
import { formatBytes } from '../utils/formatBytes.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const INVALID_TEXT = /[\u0000-\u001f\u007f\ud800-\udfff]/u;
const MIME_TYPES = new Set([
  '',
  'application/pdf',
  'application/octet-stream',
]);

function prepareValues(values) {
  const fieldErrors = {};
  const file = values?.file;
  const rawTitle = values?.title === undefined ? '' : values.title;

  const title = typeof rawTitle === 'string'
    ? rawTitle.trim().replace(/\s+/g, ' ')
    : '';

  if (
    typeof values?.subjectId !== 'string'
    || !UUID.test(values.subjectId)
  ) {
    fieldErrors.subjectId = 'Выбери доступный предмет.';
  }

  if (
    typeof rawTitle !== 'string'
    || title.length > 160
    || INVALID_TEXT.test(title)
  ) {
    fieldErrors.title =
      'Название должно содержать не больше 160 допустимых символов.';
  }

  if (typeof File === 'undefined' || !(file instanceof File)) {
    fieldErrors.file = 'Выбери PDF-файл.';
  } else {
    const fileName = file.name
      .replace(/\\/g, '/')
      .split('/')
      .at(-1)
      .trim();

    if (
      !fileName
      || fileName.length > 180
      || !/\.pdf$/i.test(fileName)
      || INVALID_TEXT.test(fileName)
      || !MIME_TYPES.has(file.type.toLowerCase())
    ) {
      fieldErrors.file =
        'Выбери PDF с корректным именем длиной до 180 символов.';
    } else if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      fieldErrors.file = 'Файл не должен быть пустым.';
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new ApiError('Проверь отмеченные поля.', {
      code: 'VALIDATION_FAILED',
      fieldErrors,
    });
  }

  // Пустой title оставляем серверу: он получит название из имени файла.
  return Object.freeze({
    subjectId: values.subjectId.toLowerCase(),
    title,
    file,
  });
}

function requireUsage(usage) {
  const valid = usage
    && Number.isSafeInteger(usage.limitBytes)
    && usage.limitBytes > 0
    && Number.isSafeInteger(usage.maxUploadBytes)
    && usage.maxUploadBytes > 0
    && usage.maxUploadBytes <= usage.limitBytes
    && Number.isSafeInteger(usage.usedBytes)
    && usage.usedBytes >= 0
    && usage.usedBytes <= usage.limitBytes
    && Number.isSafeInteger(usage.reservedBytes)
    && usage.reservedBytes >= 0
    && usage.reservedBytes <= usage.limitBytes - usage.usedBytes;

  if (!valid) {
    throw new ApiError('Сначала обнови сведения о хранилище.', {
      code: 'STORAGE_USAGE_REQUIRED',
    });
  }
}

export function createMaterialUploadAttempt(
  values,
  usage,
  previousAttempt = null,
  { randomUUID = () => globalThis.crypto.randomUUID() } = {},
) {
  const payload = prepareValues(values);

  if (previousAttempt) {
    if (
      previousAttempt.values.subjectId === payload.subjectId
      && previousAttempt.values.title === payload.title
      && previousAttempt.values.file === payload.file
    ) {
      // Первый запрос мог уже сохранить файл и занять квоту.
      // Для повтора возвращаем прежние данные и прежний ключ.
      return previousAttempt;
    }

    throw new ApiError(
      'Для этой попытки уже выбран файл и название. Проверь список материалов перед новой попыткой.',
      { code: 'UPLOAD_ATTEMPT_LOCKED' },
    );
  }

  requireUsage(usage);

  if (payload.file.size > usage.maxUploadBytes) {
    throw new ApiError('Файл превышает допустимый размер.', {
      code: 'VALIDATION_FAILED',
      fieldErrors: {
        file:
          'Выбери PDF размером не больше '
          + formatBytes(usage.maxUploadBytes)
          + '.',
      },
    });
  }

  const availableBytes =
    usage.limitBytes - usage.usedBytes - usage.reservedBytes;

  if (payload.file.size > availableBytes) {
    throw new ApiError(
      'Для этого PDF недостаточно свободного места. Обнови сведения о хранилище.',
      { code: 'STORAGE_QUOTA_EXCEEDED' },
    );
  }

  const key = randomUUID();

  if (typeof key !== 'string' || !UUID.test(key)) {
    throw new ApiError(
      'Не удалось подготовить загрузку. Попробуй снова.',
      { code: 'IDEMPOTENCY_KEY_UNAVAILABLE' },
    );
  }

  // File и ключ живут только в памяти.
  // Содержимое PDF окончательно проверяет backend.
  return Object.freeze({
    key,
    values: payload,
  });
}