import { useEffect, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';

export default function DeleteSubjectModal({
  subject,
  onClose,
  onConfirm,
}) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;

    if (!dialog.open) {
      dialog.showModal();
    }

    document.body.style.overflow = 'hidden';
    cancelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;

      if (dialog.open) {
        dialog.close();
      }

      // После удаления исходная карточка уже может отсутствовать.
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected
      ) {
        previousFocus.focus();
      } else {
        document.getElementById('main-content')?.focus();
      }
    };
  }, []);

  function handleConfirm() {
    const message = onConfirm();

    if (message) {
      setError(message);
      return;
    }

    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="subject-modal delete-subject-modal"
      aria-labelledby="delete-subject-title"
      aria-describedby="delete-subject-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="subject-modal-header">
        <span className="icon-tile danger-icon">
          <Trash2 size={24} aria-hidden="true" />
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

      <h2 id="delete-subject-title">Удалить предмет?</h2>

      <p
        id="delete-subject-description"
        className="delete-subject-description"
      >
        Предмет <strong>«{subject.title}»</strong> будет удалён
        из списка в этом браузере. Отмены удаления в интерфейсе
        пока нет.
      </p>

      <p className="subject-form-note">
        Сейчас это только локальный список. Реальные лекции
        и файлы в облаке это действие не затрагивает.
      </p>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="subject-form-actions">
        <button
          ref={cancelRef}
          type="button"
          className="secondary-button"
          onClick={onClose}
        >
          Отмена
        </button>

        <button
          type="button"
          className="danger-button"
          onClick={handleConfirm}
        >
          <Trash2 size={17} aria-hidden="true" />
          Удалить предмет
        </button>
      </div>
    </dialog>
  );
}