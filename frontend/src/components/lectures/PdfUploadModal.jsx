import { useEffect, useRef, useState } from 'react';
import { Upload, FileText, X } from 'lucide-react';

import {
  formatFileSize,
  validatePdfFile,
} from '../../services/pdfFiles.js';

export default function PdfUploadModal({ onClose, onAdd }) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const selectButtonRef = useRef(null);

  // Помогает игнорировать результат устаревшей проверки.
  const validationRef = useRef(0);

  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;

    if (!dialog.open) {
      dialog.showModal();
    }

    document.body.style.overflow = 'hidden';
    selectButtonRef.current?.focus();

    function preventFileNavigation(event) {
      const types = Array.from(event.dataTransfer?.types ?? []);

      if (types.includes('Files')) {
        event.preventDefault();
      }
    }

    // Не даём браузеру открыть файл при случайном
    // перетаскивании мимо области выбора.
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);

    return () => {
      validationRef.current += 1;

      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);

      document.body.style.overflow = previousOverflow;

      if (dialog.open) {
        dialog.close();
      }
    };
  }, []);

  async function selectFiles(fileList) {
    const requestId = ++validationRef.current;
    const files = Array.from(fileList ?? []);

    setFile(null);
    setTitle('');
    setError('');
    setIsChecking(false);

    if (files.length !== 1) {
      setError('Выбери один PDF-файл за раз.');
      return;
    }

    const selectedFile = files[0];

    setIsChecking(true);

    try {
      await validatePdfFile(selectedFile);

      if (requestId !== validationRef.current) {
        return;
      }

      setFile(selectedFile);

      const suggestedTitle = selectedFile.name
        .replace(/\.pdf$/i, '')
        .trim()
        .slice(0, 120);

      setTitle(suggestedTitle || 'Новая лекция');
    } catch (validationError) {
      if (requestId !== validationRef.current) {
        return;
      }

      setError(
        validationError instanceof Error
          ? validationError.message
          : 'Не удалось проверить файл.',
      );
    } finally {
      if (requestId === validationRef.current) {
        setIsChecking(false);
      }
    }
  }

  function handleSubmit(event) {
    event.preventDefault();

    if (isChecking) {
      return;
    }

    if (!file) {
      setError('Сначала выбери PDF-файл.');
      return;
    }

    try {
      const message = onAdd({ file, title });

      if (message) {
        setError(message);
        return;
      }

      onClose();
    } catch {
      setError('Не удалось добавить файл. Попробуй ещё раз.');
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="subject-modal pdf-upload-modal"
      aria-labelledby="pdf-upload-title"
      aria-describedby="pdf-upload-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="subject-modal-header">
        <span className="icon-tile tone-purple">
          <Upload size={24} aria-hidden="true" />
        </span>

        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Закрыть окно добавления PDF"
        >
          <X size={21} aria-hidden="true" />
        </button>
      </div>

      <h2 id="pdf-upload-title">Добавить PDF</h2>

      <p id="pdf-upload-description" className="muted">
        Выбери лекцию и задай название для её карточки.
      </p>

      <form
        className="subject-form"
        onSubmit={handleSubmit}
        noValidate
      >
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div
          className={`pdf-dropzone ${
            isDragging ? 'pdf-dropzone--active' : ''
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setIsDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            void selectFiles(event.dataTransfer.files);
          }}
        >
          <Upload size={30} aria-hidden="true" />

          <strong>Перетащи PDF сюда</strong>
          <p>Один файл размером до 10 МБ</p>

          <button
            ref={selectButtonRef}
            type="button"
            className="secondary-button"
            onClick={() => inputRef.current?.click()}
          >
            {file ? 'Выбрать другой файл' : 'Выбрать файл'}
          </button>

          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            hidden
            onChange={(event) => {
              void selectFiles(event.target.files);

              // Позволяет повторно выбрать тот же файл.
              event.target.value = '';
            }}
          />
        </div>

        {isChecking && (
          <p className="muted" role="status">
            Проверяем файл…
          </p>
        )}

        {file && (
          <div className="pdf-selected-file" role="status">
            <FileText size={23} aria-hidden="true" />

            <div>
              <strong>{file.name}</strong>
              <span>{formatFileSize(file.size)}</span>
            </div>
          </div>
        )}

        <label className="subject-field">
          <span>Название лекции *</span>

          <input
            type="text"
            name="lectureTitle"
            value={title}
            maxLength={120}
            placeholder="Например, Лекция 4. SQL-запросы"
            disabled={!file || isChecking}
            onChange={(event) => {
              setTitle(event.target.value);
              setError('');
            }}
          />
        </label>

        <p className="pdf-local-warning">
          Сейчас файл добавляется только в открытую вкладку.
          Он не отправляется в облако и исчезнет из списка после
          обновления страницы. Исходный файл на компьютере останется.
        </p>

        <div className="subject-form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            Отмена
          </button>

          <button
            type="submit"
            className="primary-button"
            disabled={!file || isChecking}
          >
            Добавить локально
          </button>
        </div>
      </form>
    </dialog>
  );
}