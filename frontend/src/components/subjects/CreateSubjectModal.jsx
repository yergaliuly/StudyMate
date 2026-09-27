import { useEffect, useRef, useState } from 'react';
import { BookOpen, X } from 'lucide-react';

const colorOptions = [
  { value: 'blue', label: 'Синий' },
  { value: 'purple', label: 'Фиолетовый' },
  { value: 'indigo', label: 'Индиго' },
  { value: 'green', label: 'Зелёный' },
];

export default function CreateSubjectModal({ onClose, onCreate }) {
  const dialogRef = useRef(null);
  const titleRef = useRef(null);

  const [error, setError] = useState('');

  const [form, setForm] = useState({
    title: '',
    description: '',
    icon: 'book',
    tone: 'blue',
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;

    if (!dialog.open) {
      dialog.showModal();
    }

    document.body.style.overflow = 'hidden';
    titleRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;

      if (dialog.open) {
        dialog.close();
      }
    };
  }, []);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setError('');
  }

  function handleSubmit(event) {
    event.preventDefault();

    const message = onCreate(form);

    if (message) {
      setError(message);
      titleRef.current?.focus();
      return;
    }

    onClose();
  }

  function handleBackdropClick(event) {
    if (event.target !== event.currentTarget) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();

    const outside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;

    if (outside) {
      onClose();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="subject-modal"
      aria-labelledby="create-subject-title"
      aria-describedby="create-subject-description"
      onClick={handleBackdropClick}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="subject-modal-header">
        <span className={`icon-tile tone-${form.tone}`}>
          <BookOpen size={25} aria-hidden="true" />
        </span>

        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Закрыть окно"
        >
          <X size={21} aria-hidden="true" />
        </button>
      </div>

      <h2 id="create-subject-title">Новый предмет</h2>

      <p id="create-subject-description" className="muted">
        Добавь предмет и выбери оформление его карточки.
      </p>

      <form className="subject-form" onSubmit={handleSubmit} noValidate>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <label className="subject-field">
          <span>Название предмета *</span>

          <input
            ref={titleRef}
            name="title"
            type="text"
            value={form.title}
            onChange={(event) => updateField('title', event.target.value)}
            placeholder="Например, Физика"
            maxLength={60}
            required
          />
        </label>

        <label className="subject-field">
          <span>
            Описание <small>необязательно</small>
          </span>

          <textarea
            name="description"
            rows={3}
            value={form.description}
            onChange={(event) =>
              updateField('description', event.target.value)
            }
            placeholder="Что будем изучать?"
            maxLength={160}
          />

          <span className="field-hint">
            {form.description.length}/160
          </span>
        </label>

        <label className="subject-field">
          <span>Иконка карточки</span>

          <select
            name="icon"
            value={form.icon}
            onChange={(event) => updateField('icon', event.target.value)}
          >
            <option value="book">Книга</option>
            <option value="database">База данных</option>
            <option value="languages">Языки</option>
            <option value="code">Программирование</option>
          </select>
        </label>

        <fieldset className="subject-colors">
          <legend>Цвет карточки</legend>

          <div className="subject-color-grid">
            {colorOptions.map((option) => (
              <label
                key={option.value}
                className={`subject-color-option tone-${option.value}`}
              >
                <input
                  type="radio"
                  name="tone"
                  value={option.value}
                  checked={form.tone === option.value}
                  onChange={(event) =>
                    updateField('tone', event.target.value)
                  }
                />

                <span className="subject-color-dot" aria-hidden="true" />

                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <p className="subject-form-note">
          Пока предмет сохраняется только в этом браузере,
          без аккаунта и сервера.
        </p>

        <div className="subject-form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            Отмена
          </button>

          <button type="submit" className="primary-button">
            Создать предмет
          </button>
        </div>
      </form>
    </dialog>
  );
}