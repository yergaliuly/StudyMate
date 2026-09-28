import { ApiError } from './apiClient.js';

const ICONS = ['book', 'database', 'languages', 'code'];
const TONES = ['blue', 'purple', 'indigo', 'green'];
const KEY_LIFETIME = 24 * 60 * 60 * 1000;

export function prepareSubjectValues(values) {
  const fieldErrors = {};
  const title = typeof values?.title === 'string'
    ? values.title.trim().replace(/\s+/g, ' ') : '';
  const rawDescription = values?.description === undefined ? '' : values.description;
  const description = typeof rawDescription === 'string' ? rawDescription.trim() : '';

  if (typeof values?.title !== 'string' || title.length < 2 || title.length > 60) {
    fieldErrors.title = 'Название должно содержать от 2 до 60 символов.';
  }
  if (typeof rawDescription !== 'string' || description.length > 160) {
    fieldErrors.description = 'Описание должно содержать не больше 160 символов.';
  }
  if (!ICONS.includes(values?.icon)) fieldErrors.icon = 'Выбери иконку из списка.';
  if (!TONES.includes(values?.tone)) fieldErrors.tone = 'Выбери цвет из списка.';
  if (Object.keys(fieldErrors).length) {
    throw new ApiError('Проверь отмеченные поля.', { code: 'VALIDATION_FAILED', fieldErrors });
  }

  // Уникальность проверяет сервер среди всех предметов аккаунта.
  return { title, description, icon: values.icon, tone: values.tone };
}

export function createSubjectAttempt(values, previousAttempt = null, {
  now = () => Date.now(),
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  const payload = prepareSubjectValues(values);
  const signature = JSON.stringify(payload);
  const timestamp = now();
  if (previousAttempt?.signature === signature) {
    if (timestamp - previousAttempt.createdAt >= KEY_LIFETIME) {
      throw new ApiError(
        'Срок безопасного повтора истёк. Проверь список предметов перед новым созданием.',
        { code: 'IDEMPOTENCY_EXPIRED' },
      );
    }
    return previousAttempt;
  }

  return {
    key: randomUUID(),
    values: Object.freeze(payload),
    signature,
    createdAt: timestamp,
  };
}
