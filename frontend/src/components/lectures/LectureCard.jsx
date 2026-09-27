import { FileText, ArrowRight } from 'lucide-react';

export default function LectureCard({ lecture }) {
  return (
    <article className="panel lecture-card">
      <div className="lecture-card-top">
        <span className="icon-tile tone-blue">
          <FileText size={23} aria-hidden="true" />
        </span>

        <span className="demo-badge">Пример</span>
      </div>

      <h3>{lecture.title}</h3>

      <p className="lecture-description">
        {lecture.description}
      </p>

      <div className="lecture-card-footer">
        <span>Макет карточки лекции</span>

        <button
          type="button"
          className="secondary-button"
          aria-label={`Просмотр «${lecture.title}» пока недоступен`}
          disabled
        >
          Открыть
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>

      <p className="lecture-card-note">
        PDF ещё не загружен. Просмотр подключим позже.
      </p>
    </article>
  );
}