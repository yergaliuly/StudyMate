export const MAX_PDF_BYTES = 10_000_000;

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }

  if (bytes < 1000) {
    return `${bytes} Б`;
  }

  if (bytes < 1_000_000) {
    return `${Math.ceil(bytes / 1000)} КБ`;
  }

  return `${(bytes / 1_000_000).toLocaleString('ru-RU', {
    maximumFractionDigits: 2,
  })} МБ`;
}

export async function validatePdfFile(file) {
  if (!(file instanceof File)) {
    throw new Error('Выбери PDF-файл.');
  }

  if (!/\.pdf$/i.test(file.name)) {
    throw new Error('В этой версии можно добавлять только PDF.');
  }

  if (file.size === 0) {
    throw new Error('Файл пустой. Выбери другой PDF.');
  }

  if (file.size > MAX_PDF_BYTES) {
    throw new Error('Размер файла превышает 10 МБ.');
  }

  let header;

  try {
    header = await file.slice(0, 5).text();
  } catch {
    throw new Error('Не удалось прочитать файл. Выбери его заново.');
  }

  if (header !== '%PDF-') {
    throw new Error('Начало файла не соответствует формату PDF.');
  }
}

// Вызываем после validatePdfFile.
// Создаёт временную запись, ничего не отправляя на сервер.
export function createLocalLecture(
  subjectId,
  values,
  existingLectures,
) {
  const { file } = values;
  const title = values.title.trim().replace(/\s+/g, ' ');

  if (!(file instanceof File)) {
    throw new Error('Сначала выбери PDF-файл.');
  }

  if (title.length < 2 || title.length > 120) {
    throw new Error(
      'Название лекции должно содержать от 2 до 120 символов.',
    );
  }

  const duplicate = existingLectures.some(
    (lecture) =>
      lecture.subjectId === subjectId &&
      lecture.file?.name === file.name &&
      lecture.file?.size === file.size &&
      lecture.file?.lastModified === file.lastModified,
  );

  if (duplicate) {
    throw new Error(
      'Похоже, этот файл уже добавлен в выбранный предмет.',
    );
  }

  return {
    id: crypto.randomUUID(),
    subjectId,
    title,
    description: file.name,
    source: 'local',
    file,
  };
}