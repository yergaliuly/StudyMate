import { useEffect, useId, useRef, useState } from 'react';

import {
  Database,
  Languages,
  Code,
  BookOpen,
  ArrowRight,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';

const subjectIcons = {
  book: BookOpen,
  database: Database,
  languages: Languages,
  code: Code,
};

export default function SubjectCard({
  subject,
  onOpen,
  onEdit,
  onDelete,
  isDemo = true,
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const actionsRef = useRef(null);
  const toggleRef = useRef(null);
  const actionsId = useId();

  const Icon = subjectIcons[subject.icon] ?? BookOpen;

  const progress = typeof subject.progress === 'number' && Number.isFinite(subject.progress)
    ? Math.min(100, Math.max(0, subject.progress))
    : null;
  const hasActions = Boolean(onEdit || onDelete);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    function handleOutsideClick(event) {
      if (!actionsRef.current?.contains(event.target)) {
        setIsMenuOpen(false);
      }
    }

    function handleEscape(event) {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
        toggleRef.current?.focus();
      }
    }

    document.addEventListener('pointerdown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('pointerdown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isMenuOpen]);

  function runAction(action) {
    // Возвращаем фокус на кнопку перед открытием модального окна.
    toggleRef.current?.focus();
    setIsMenuOpen(false);
    action(subject);
  }

  return (
    <article
      className={[
        'subject-card',
        `tone-${subject.tone}`,
        isMenuOpen ? 'subject-card--menu-open' : '',
      ].join(' ')}
    >
      <div className="subject-card-top">
        <span className="icon-tile">
          <Icon size={24} aria-hidden="true" />
        </span>

        {(hasActions || onOpen) && (
          <div className="subject-card-controls">
            {hasActions && (
              <div
                ref={actionsRef}
                className="subject-actions"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    setIsMenuOpen(false);
                  }
                }}
              >
                <button
                  ref={toggleRef}
                  type="button"
                  className="icon-button subject-menu-toggle"
                  aria-label={`Действия с предметом «${subject.title}»`}
                  aria-expanded={isMenuOpen}
                  aria-controls={isMenuOpen ? actionsId : undefined}
                  onClick={() => setIsMenuOpen((current) => !current)}
                >
                  <MoreHorizontal size={21} aria-hidden="true" />
                </button>

                {isMenuOpen && (
                  <div id={actionsId} className="subject-actions-menu">
                    {onEdit && (
                      <button type="button" onClick={() => runAction(onEdit)}>
                        <Pencil size={16} aria-hidden="true" />
                        Редактировать
                      </button>
                    )}

                    {onDelete && (
                      <button
                        type="button"
                        className="subject-action-danger"
                        onClick={() => runAction(onDelete)}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                        Удалить
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {onOpen && (
              <button
                type="button"
                className="subject-open"
                onClick={() => onOpen(subject)}
                aria-label={`Открыть предмет «${subject.title}»`}
              >
                <ArrowRight size={19} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      <h3>{subject.title}</h3>

      <p className="subject-description">
        {subject.description || 'Описание пока не добавлено'}
      </p>

      <div className="subject-meta">
        <span>{subject.lectures} лекций</span>
        {progress !== null && <strong>{progress}%</strong>}
      </div>

      {progress !== null && (
        <div
          className="progress-track"
          role="progressbar"
          aria-label={`${isDemo ? 'Демонстрационный прогресс' : 'Прогресс'}: ${subject.title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
    </article>
  );
}
