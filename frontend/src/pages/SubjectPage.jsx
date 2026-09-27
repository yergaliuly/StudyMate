import { useState } from 'react';

import {
  ArrowLeft,
  BookOpen,
  Database,
  Languages,
  Code,
  Pencil,
  Trash2,
  Upload,
  Search,
  FileText,
  Info,
} from 'lucide-react';

import LectureCard from '../components/lectures/LectureCard.jsx';
import PdfUploadModal from '../components/lectures/PdfUploadModal.jsx';

const subjectIcons = {
  book: BookOpen,
  database: Database,
  languages: Languages,
  code: Code,
};

export default function SubjectPage({
  subject,
  lectures = [],
  onBack,
  onEdit,
  onDelete,
  onAddLecture,
}) {
  const [lectureQuery, setLectureQuery] = useState('');
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const Icon = subjectIcons[subject.icon] ?? BookOpen;
  const normalizedQuery = lectureQuery.trim().toLowerCase();

  const filteredLectures = lectures.filter((lecture) => {
    const text = `${lecture.title} ${lecture.description}`.toLowerCase();
    return text.includes(normalizedQuery);
  });

  function handleAddLecture(values) {
    const error = onAddLecture(values);

    if (!error) {
      // Новая карточка должна быть видна даже при прежнем фильтре.
      setLectureQuery('');
    }

    return error;
  }

  return (
    <div className="subject-page">
      <button
        type="button"
        className="subject-back"
        onClick={onBack}
      >
        <ArrowLeft size={18} aria-hidden="true" />
        К моим предметам
      </button>

      <section
        className={`panel subject-overview tone-${subject.tone}`}
        aria-labelledby="subject-page-title"
      >
        <div className="subject-overview-top">
          <div className="subject-identity">
            <span className="icon-tile subject-large-icon">
              <Icon size={30} aria-hidden="true" />
            </span>

            <div className="subject-identity-copy">
              <p className="eyebrow">МОИ ПРЕДМЕТЫ</p>

              <h1 id="subject-page-title">
                {subject.title}
              </h1>
            </div>
          </div>

          <div className="subject-page-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onEdit}
            >
              <Pencil size={16} aria-hidden="true" />
              Редактировать
            </button>

            <button
              type="button"
              className="secondary-button subject-delete-button"
              onClick={onDelete}
            >
              <Trash2 size={16} aria-hidden="true" />
              Удалить
            </button>
          </div>
        </div>

        <p className="subject-page-description">
          {subject.description ||
            'Добавь описание через кнопку «Редактировать».'}
        </p>

        <div className="demo-notice subject-page-notice">
          <Info size={19} aria-hidden="true" />

          <p>
            Выбранные PDF доступны до перезагрузки приложения.
            Они не отправлены на сервер. Карточки с пометкой
            «Пример» остаются демонстрационными.
          </p>
        </div>
      </section>

      <section aria-labelledby="subject-materials-title">
        <div className="section-heading">
          <div>
            <h2 id="subject-materials-title">
              Лекции и материалы
            </h2>

            <p className="muted">
              Выбирай PDF и проверяй материалы перед отправкой
            </p>
          </div>

          <button
            type="button"
            className="primary-button"
            onClick={() => setIsUploadOpen(true)}
          >
            <Upload size={18} aria-hidden="true" />
            Добавить PDF
          </button>
        </div>

        {lectures.length > 0 && (
          <div className="materials-toolbar">
            <label className="search-box lecture-search">
              <Search size={18} aria-hidden="true" />

              <span className="visually-hidden">
                Поиск лекций в этом предмете
              </span>

              <input
                type="search"
                placeholder="Найти лекцию..."
                value={lectureQuery}
                onChange={(event) =>
                  setLectureQuery(event.target.value)
                }
              />
            </label>

            <p className="materials-count" role="status">
              Найдено: {filteredLectures.length} из {lectures.length}
            </p>
          </div>
        )}

        {lectures.length === 0 ? (
          <div className="panel empty-state materials-empty">
            <span className="materials-empty-icon">
              <FileText size={32} aria-hidden="true" />
            </span>

            <h3>Пока нет лекций</h3>

            <p>
              Нажми «Добавить PDF», чтобы выбрать первый материал
              для этого предмета.
            </p>
          </div>
        ) : filteredLectures.length > 0 ? (
          <div className="lectures-grid">
            {filteredLectures.map((lecture) => (
              <LectureCard
                key={lecture.id}
                lecture={lecture}
              />
            ))}
          </div>
        ) : (
          <div className="panel empty-state materials-empty">
            <Search size={30} aria-hidden="true" />

            <h3>Лекции не найдены</h3>

            <p>Попробуй другое название или очисти поиск.</p>

            <button
              type="button"
              className="secondary-button"
              onClick={() => setLectureQuery('')}
            >
              Очистить поиск
            </button>
          </div>
        )}
      </section>

      {isUploadOpen && (
        <PdfUploadModal
          onClose={() => setIsUploadOpen(false)}
          onAdd={handleAddLecture}
        />
      )}
    </div>
  );
}