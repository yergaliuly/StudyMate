import { demoSubjects } from '../mocks/dashboard.js';

const STORAGE_KEY = 'studymate.demo.subjects.v1';

const icons = ['book', 'database', 'languages', 'code'];
const tones = ['blue', 'purple', 'indigo', 'green'];

// Убираем пробелы по краям и повторяющиеся пробелы внутри названия.
function normalizeTitle(title) {
  return title.trim().replace(/\s+/g, ' ');
}

// Проверяем структуру предмета, прочитанного из хранилища.
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

// Загружаем предметы из локального хранилища.
export function loadSubjects() {
  const fallback = demoSubjects.map((subject) => ({ ...subject }));

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    const subjects = raw === null
      ? fallback
      : JSON.parse(raw);

    if (
      !Array.isArray(subjects) ||
      !subjects.every(isValidSubject) ||
      new Set(subjects.map((subject) => subject.id)).size !== subjects.length
    ) {
      throw new Error('Некорректный формат сохранённых предметов.');
    }

    return {
      subjects,
      canPersist: true,
      warning: '',
    };
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

// Сохраняем весь список предметов.
// Пустая строка означает, что сохранение прошло без ошибки.
export function saveSubjects(subjects) {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(subjects),
    );

    return '';
  } catch {
    return 'Не удалось сохранить изменения в браузере. Пока они доступны только на открытой странице.';
  }
}

// Общая проверка формы при создании и редактировании.
function validateSubjectForm(values, existingSubjects, ignoredId = null) {
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
      subject.id !== ignoredId &&
      normalizeTitle(subject.title).toLowerCase() === title.toLowerCase(),
  );

  if (duplicate) {
    throw new Error('Предмет с таким названием уже есть.');
  }

  if (!icons.includes(values.icon) || !tones.includes(values.tone)) {
    throw new Error('Выбери иконку и цвет из предложенных вариантов.');
  }

  return {
    title,
    description,
    icon: values.icon,
    tone: values.tone,
  };
}

// Создаём новый предмет.
export function createSubject(values, existingSubjects) {
  const fields = validateSubjectForm(values, existingSubjects);

  return {
    id: crypto.randomUUID(),
    ...fields,
    lectures: 0,
    progress: 0,
  };
}

// Изменяем существующий предмет.
export function updateSubject(subjectId, values, existingSubjects) {
  const currentSubject = existingSubjects.find(
    (subject) => subject.id === subjectId,
  );

  if (!currentSubject) {
    throw new Error('Предмет не найден.');
  }

  const fields = validateSubjectForm(
    values,
    existingSubjects,
    subjectId,
  );

  // Сохраняем ID, количество лекций и прогресс.
  return {
    ...currentSubject,
    ...fields,
  };
}

// Возвращаем список без удалённого предмета.
export function removeSubject(subjectId, existingSubjects) {
  const exists = existingSubjects.some(
    (subject) => subject.id === subjectId,
  );

  if (!exists) {
    throw new Error('Предмет не найден.');
  }

  return existingSubjects.filter(
    (subject) => subject.id !== subjectId,
  );
}