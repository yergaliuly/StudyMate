import { demoSubjects } from '../mocks/dashboard.js';

const STORAGE_KEY = 'studymate.demo.subjects.v1';
const icons = ['book', 'database', 'languages', 'code'];
const tones = ['blue', 'purple', 'indigo', 'green'];

function normalizeTitle(title) {
  return title.trim().replace(/\s+/g, ' ');
}

function isValidSubject(subject) {
  return (
    subject !== null &&
    typeof subject === 'object' &&
    typeof subject.id === 'string' &&
    subject.id.length > 0 &&
    typeof subject.title === 'string' &&
    normalizeTitle(subject.title).length >= 2 &&
    subject.title.length <= 60 &&
    typeof subject.description === 'string' &&
    subject.description.length <= 160 &&
    Number.isInteger(subject.lectures) &&
    subject.lectures >= 0 &&
    Number.isFinite(subject.progress) &&
    subject.progress >= 0 &&
    subject.progress <= 100 &&
    icons.includes(subject.icon) &&
    tones.includes(subject.tone)
  );
}

export function loadSubjects() {
  const fallback = demoSubjects.map((subject) => ({ ...subject }));

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const subjects = raw === null ? fallback : JSON.parse(raw);

    if (
      !Array.isArray(subjects) ||
      !subjects.every(isValidSubject) ||
      new Set(subjects.map((subject) => subject.id)).size !== subjects.length
    ) {
      throw new Error('Некорректный формат сохранённых предметов.');
    }

    return { subjects, canPersist: true, warning: '' };
  } catch {
    // Не перезаписываем данные, которые не удалось прочитать.
    return {
      subjects: fallback,
      canPersist: false,
      warning:
        'Не удалось прочитать хранилище браузера. Показаны примеры; новые предметы будут доступны только до перезагрузки страницы.',
    };
  }
}

export function saveSubjects(subjects) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(subjects));
    return '';
  } catch {
    return 'Не удалось сохранить изменения в браузере. Пока они доступны только на открытой странице.';
  }
}

export function createSubject(values, existingSubjects) {
  const title = normalizeTitle(values.title);
  const description = values.description.trim();

  if (title.length < 2 || title.length > 60) {
    throw new Error('Название должно содержать от 2 до 60 символов.');
  }

  if (description.length > 160) {
    throw new Error('Описание должно содержать не больше 160 символов.');
  }

  const duplicate = existingSubjects.some(
    (subject) =>
      normalizeTitle(subject.title).toLowerCase() === title.toLowerCase(),
  );

  if (duplicate) {
    throw new Error('Предмет с таким названием уже есть.');
  }

  if (!icons.includes(values.icon) || !tones.includes(values.tone)) {
    throw new Error('Выбери иконку и цвет из предложенных вариантов.');
  }

  return {
    id: crypto.randomUUID(),
    title,
    description,
    icon: values.icon,
    tone: values.tone,
    lectures: 0,
    progress: 0,
  };
}