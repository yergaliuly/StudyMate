import {
  Database,
  Languages,
  Code,
  BookOpen,
  ArrowRight,
} from 'lucide-react';

const subjectIcons = {
  database: Database,
  languages: Languages,
  code: Code,
};

export default function SubjectCard({ subject, onOpen }) {
  const Icon = subjectIcons[subject.icon] ?? BookOpen;

  const progress = Math.min(
    100,
    Math.max(0, Number(subject.progress) || 0),
  );

  return (
    <article className={`subject-card tone-${subject.tone}`}>
      <div className="subject-card-top">
        <span className="icon-tile">
          <Icon size={24} aria-hidden="true" />
        </span>

        <button
          type="button"
          className="subject-open"
          onClick={() => onOpen(subject)}
          aria-label={`Открыть предмет «${subject.title}»`}
        >
          <ArrowRight size={19} aria-hidden="true" />
        </button>
      </div>

      <h3>{subject.title}</h3>
      <p className="subject-description">{subject.description}</p>

      <div className="subject-meta">
        <span>{subject.lectures} лекций</span>
        <strong>{progress}%</strong>
      </div>

      <div
        className="progress-track"
        role="progressbar"
        aria-label={`Демонстрационный прогресс: ${subject.title}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
    </article>
  );
}