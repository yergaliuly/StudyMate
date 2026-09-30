import { useEffect, useId, useRef, useState } from 'react';
import { Upload } from 'lucide-react';

import { materialApi } from '../../services/materialApi.js';
import { createMaterialUploadAttempt } from '../../services/materialUploadDraft.js';
import { formatBytes } from '../../utils/formatBytes.js';
import '../../styles/materialUpload.css';

const uncertainMessage =
  'Ответ загрузки не подтверждён. Файл мог сохраниться. Обнови список и квоту или повтори прежний запрос.';

const messages = {
  VALIDATION_FAILED: 'Проверь отмеченные поля.',
  INVALID_PDF: 'Сервер не распознал корректный PDF. Выбери другой файл.',
  PAYLOAD_TOO_LARGE: 'Файл или запрос превышает допустимый размер.',
  STORAGE_QUOTA_EXCEEDED: 'Недостаточно места. Обнови сведения о хранилище.',
  STORAGE_USAGE_REQUIRED: 'Сначала обнови сведения о хранилище.',
  STORAGE_UNAVAILABLE: 'Хранилище файлов сейчас недоступно. Попробуй позже.',
  UPLOAD_FAILED: 'Сохранение PDF не подтверждено. Обнови список и квоту; освобождение резерва может занять время.',
  REQUEST_IN_PROGRESS: 'Эта загрузка ещё выполняется. Подожди перед повтором.',
  UPLOAD_BUSY: 'Сервер занят другими загрузками. Подожди перед повтором.',
  RATE_LIMITED: 'Слишком много запросов. Подожди перед повтором.',
  UPLOAD_ABORTED: 'Эта попытка больше не может быть завершена. Обнови список и квоту перед новой загрузкой.',
  IDEMPOTENCY_KEY_REUSED: 'Сохранённая попытка не соответствует запросу. Обнови список и квоту перед новой загрузкой.',
  UPLOAD_ATTEMPT_LOCKED: 'Повтор должен использовать прежний файл и название.',
  IDEMPOTENCY_KEY_UNAVAILABLE: 'Не удалось подготовить загрузку. Попробуй снова.',
};

function messageFor(error) {
  return typeof messages[error?.code] === 'string'
    ? messages[error.code]
    : 'Не удалось подтвердить загрузку. Проверь список и попробуй снова.';
}

function accessError(error) {
  return (
    error?.status === 401
    && error.code === 'AUTHENTICATION_REQUIRED'
  ) || (
    error?.status === 403
    && error.code === 'CSRF_INVALID'
  ) || error?.code === 'CSRF_NOT_INITIALIZED';
}

function editableFailure(error) {
  return (
    error?.status === 422
    && ['VALIDATION_FAILED', 'INVALID_PDF'].includes(error.code)
  ) || (
    error?.status === 413
    && error.code === 'PAYLOAD_TOO_LARGE'
  );
}

function uncertainFailure(error) {
  if ([
    'NETWORK_ERROR',
    'INVALID_RESPONSE',
    'REQUEST_CANCELLED',
    'REQUEST_IN_PROGRESS',
    'UPLOAD_FAILED',
  ].includes(error?.code)) {
    return true;
  }

  if (error?.status >= 500) return true;
  if (editableFailure(error) || accessError(error)) return false;

  return ![
    'STORAGE_QUOTA_EXCEEDED',
    'UPLOAD_BUSY',
    'RATE_LIMITED',
    'UPLOAD_ABORTED',
    'IDEMPOTENCY_KEY_REUSED',
    'SUBJECT_NOT_FOUND',
  ].includes(error?.code);
}

function fieldErrors(error) {
  const result = {};

  for (const name of ['file', 'title']) {
    if (typeof error?.fieldErrors?.[name] === 'string') {
      result[name] = error.fieldErrors[name];
    }
  }

  if (error?.code === 'INVALID_PDF') {
    result.file = messages.INVALID_PDF;
  }

  if (error?.code === 'PAYLOAD_TOO_LARGE') {
    result.file = messages.PAYLOAD_TOO_LARGE;
  }

  return result;
}

export default function MaterialUploadForm({
  subjectId,
  record,
  usage,
  canAct,
  reviewStatus,
  onStart,
  onUploaded,
  onReview,
  onAccessError,
  onUnavailable,
}) {
  const [draft] = useState(() => {
    record.upload ??= {
      file: null,
      title: '',
      attempt: null,
      pending: false,
      uncertain: false,
      stopped: false,
      retryAt: 0,
      message: '',
      notice: '',
      errors: {},
    };

    return record.upload;
  });

  const [view, setView] = useState(() => ({ ...draft }));
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(Date.now);

  const mounted = useRef(false);
  const requestRef = useRef(null);
  const fileInputRef = useRef(null);
  const formRef = useRef(null);
  const focusErrorRef = useRef('');
  const id = useId();

  const callbacks = useRef({});
  callbacks.current = {
    canAct,
    onStart,
    onUploaded,
    onReview,
    onAccessError,
    onUnavailable,
  };

  const active = () => mounted.current
    && record.upload === draft
    && callbacks.current.canAct();

  const locked = view.pending || Boolean(view.attempt);
  const remaining = Math.max(0, Math.ceil((view.retryAt - now) / 1000));
  const needsReview = view.uncertain || view.stopped;

  function save(changes) {
    Object.assign(draft, changes);
    if (active()) setView({ ...draft });
  }

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;

      if (requestRef.current) {
        // Отмена ожидания не отменяет сохранение на сервере.
        // Не возвращаем запись в App ref: при выходе он мог быть очищен.
        if (draft.pending) {
          Object.assign(draft, {
            pending: false,
            uncertain: true,
            message: uncertainMessage,
          });
        }

        requestRef.current.abort();
        requestRef.current = null;
      }
    };
  }, [draft]);

  useEffect(() => {
    if (view.retryAt <= Date.now()) return undefined;

    const timer = window.setInterval(() => {
      const timestamp = Date.now();
      setNow(timestamp);

      if (timestamp >= view.retryAt) {
        window.clearInterval(timer);
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [view.retryAt]);

  useEffect(() => {
    if (view.pending || !focusErrorRef.current) return;

    const control = formRef.current?.elements.namedItem(focusErrorRef.current);
    if (control && !control.disabled) control.focus();

    focusErrorRef.current = '';
  }, [view.errors, view.pending]);

  function change(field, value) {
    if (!active() || draft.pending || draft.attempt) return;

    save({
      [field]: value,
      message: '',
      notice: '',
      errors: { ...draft.errors, [field]: undefined },
    });
  }

  function review() {
    if (!active() || draft.pending) return;

    setConfirmed(false);
    callbacks.current.onReview();
  }

  function newAttempt() {
    if (!active() || draft.pending || !draft.attempt) return;

    if (
      (draft.uncertain || draft.stopped)
      && (reviewStatus !== 'ready' || !confirmed)
    ) {
      return;
    }

    save({
      attempt: null,
      uncertain: false,
      stopped: false,
      errors: {},
      message: '',
      notice: '',
    });

    setConfirmed(false);
    setNow(Date.now());

    // Выбор файла и название остаются.
    // Срок Retry-After также сохраняется.
  }

  async function submit(event) {
    event.preventDefault();

    if (
      !active()
      || requestRef.current
      || draft.pending
      || draft.stopped
      || Date.now() < draft.retryAt
    ) {
      return;
    }

    const hadUncertainResult = draft.uncertain;
    const replay = Boolean(draft.attempt);
    let attempt;

    try {
      attempt = createMaterialUploadAttempt(
        draft.attempt?.values ?? {
          file: draft.file,
          title: draft.title,
          subjectId,
        },
        usage,
        draft.attempt,
      );
    } catch (error) {
      const errors = fieldErrors(error);

      focusErrorRef.current =
        ['file', 'title'].find((field) => errors[field]) ?? '';

      save({
        errors,
        message: messageFor(error),
        notice: '',
      });

      return;
    }

    const controller = new AbortController();
    requestRef.current = controller;

    const current = () => active()
      && !controller.signal.aborted
      && requestRef.current === controller
      && draft.attempt === attempt;

    save({
      attempt,
      pending: true,
      retryAt: 0,
      message: '',
      notice: '',
      errors: {},
    });

    setConfirmed(false);
    setNow(Date.now());
    callbacks.current.onStart();

    try {
      const uploaded = await materialApi.upload(attempt.values, {
      idempotencyKey: attempt.key,
      signal: controller.signal,
    });

      if (!current()) return;

      save({
        file: null,
        title: '',
        attempt: null,
        pending: false,
        uncertain: false,
        stopped: false,
        retryAt: 0,
        errors: {},
        message: '',
        notice: replay
          ? 'Сервер подтвердил прежнюю загрузку. Актуальное состояние — в обновлённом списке.'
          : 'PDF сохранён. Обновляем список и свободное место.',
      });

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      callbacks.current.onUploaded(uploaded);
    } catch (error) {
      if (!current()) return;

      const uncertain =
        hadUncertainResult || uncertainFailure(error);

      const stopped = [
        'UPLOAD_ABORTED',
        'IDEMPOTENCY_KEY_REUSED',
      ].includes(error?.code);

      const editable =
        !uncertain && !stopped && editableFailure(error);

      const errors = fieldErrors(error);

      const seconds = Number.isSafeInteger(error?.retryAfterSeconds)
        && error.retryAfterSeconds >= 0
        ? error.retryAfterSeconds
        : ['REQUEST_IN_PROGRESS', 'UPLOAD_BUSY'].includes(error?.code)
          ? 2
          : 0;

      const retryAt = seconds > 0
        ? Math.min(
            Number.MAX_SAFE_INTEGER,
            Date.now() + seconds * 1000,
          )
        : 0;

      save({
        pending: false,
        uncertain,
        stopped,
        retryAt,
        errors,
        attempt: editable ? null : attempt,
        message: messageFor(error),
      });

      setNow(Date.now());

      focusErrorRef.current = editable
        ? ['file', 'title'].find((field) => errors[field]) ?? ''
        : '';

      if (accessError(error)) {
        save({
          message: 'После восстановления доступа повтори загрузку вручную.',
        });

        callbacks.current.onAccessError(error);
      } else if (
        error?.status === 404
        && error.code === 'SUBJECT_NOT_FOUND'
      ) {
        callbacks.current.onUnavailable();
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
      }
    }
  }

  return (
    <section
      className="panel material-upload"
      aria-labelledby={id + '-heading'}
    >
      <div className="material-upload-heading">
        <Upload size={24} aria-hidden="true" />

        <div>
          <h3 id={id + '-heading'}>Загрузить PDF</h3>
          <p>Файл сохранится в этом предмете.</p>
        </div>
      </div>

      <form
        ref={formRef}
        onSubmit={submit}
        noValidate
        aria-busy={view.pending}
      >
        {view.notice && (
          <p className="material-upload-notice" role="status">
            {view.notice}
          </p>
        )}

        {view.message && (
          <p className="form-error" role="alert">
            {view.message}
          </p>
        )}

        {view.uncertain && !view.stopped && !view.pending && (
          <p className="material-upload-warning">
            {uncertainMessage}
          </p>
        )}

        <div className="material-upload-field">
          <label htmlFor={id + '-file'}>PDF-файл</label>

          <input
            ref={fileInputRef}
            id={id + '-file'}
            name="file"
            type="file"
            accept=".pdf,application/pdf"
            disabled={locked}
            aria-invalid={Boolean(view.errors.file)}
            aria-describedby={
              id + '-file-note'
              + (view.errors.file ? ' ' + id + '-file-error' : '')
            }
            onChange={(event) => change(
              'file',
              event.target.files?.[0] ?? null,
            )}
          />

          <p id={id + '-file-note'} className="material-upload-hint">
            {view.file
              ? 'Выбран: ' + view.file.name + ' · ' + formatBytes(view.file.size)
              : 'Выбери один PDF на компьютере.'}
          </p>

          {view.errors.file && (
            <p id={id + '-file-error'} className="form-error">
              {view.errors.file}
            </p>
          )}
        </div>

        <div className="material-upload-field">
          <label htmlFor={id + '-title'}>
            Название материала (необязательно)
          </label>

          <input
            id={id + '-title'}
            name="title"
            type="text"
            value={view.title}
            maxLength={160}
            disabled={locked}
            placeholder="Если оставить пустым — используем имя файла"
            aria-invalid={Boolean(view.errors.title)}
            aria-describedby={
              view.errors.title ? id + '-title-error' : undefined
            }
            onChange={(event) => change('title', event.target.value)}
          />

          {view.errors.title && (
            <p id={id + '-title-error'} className="form-error">
              {view.errors.title}
            </p>
          )}
        </div>

        <p className="material-upload-hint">
          {usage
            ? 'Один PDF — до ' + formatBytes(usage.maxUploadBytes) + '. '
            : 'Для новой загрузки нужны сведения о хранилище. '}
          Выбранный файл и попытка сохраняются в памяти
          до перезагрузки страницы или выхода.
        </p>

        {view.pending && (
          <p role="status">
            Загружаем PDF. Дождись ответа сервера…
          </p>
        )}

        {remaining > 0 && (
          <p role="status">
            Повтор доступен через {remaining} сек.
          </p>
        )}

        <div className="material-upload-actions">
          <button
            type="submit"
            className="primary-button"
            disabled={
              view.pending
              || view.stopped
              || remaining > 0
              || (!view.attempt && !usage)
            }
          >
            <Upload size={17} aria-hidden="true" />

            {view.pending
              ? 'Загружаем…'
              : view.attempt
                ? 'Повторить загрузку'
                : 'Загрузить PDF'}
          </button>

          <button
            type="button"
            className="secondary-button"
            disabled={view.pending || reviewStatus === 'loading'}
            onClick={review}
          >
            Обновить список и квоту
          </button>
        </div>

        {view.attempt && !view.pending && (
          <div className="material-upload-restart">
            {needsReview && (
              <>
                <p>
                  Новая попытка использует новый запрос
                  и может создать ещё одну копию PDF.
                </p>

                <p className="material-upload-hint">
                  {reviewStatus === 'ready'
                    ? 'Список и квота обновлены. Проверь материалы ниже.'
                    : reviewStatus === 'error'
                      ? 'Не удалось завершить проверку. Обнови список и квоту ещё раз.'
                      : 'Сначала нажми «Обновить список и квоту» и проверь материалы ниже.'}
                </p>

                <label className="material-upload-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={reviewStatus !== 'ready'}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  Я проверил список и хочу начать новую попытку
                </label>
              </>
            )}

            <button
              type="button"
              className="secondary-button"
              disabled={
                needsReview
                && (reviewStatus !== 'ready' || !confirmed)
              }
              onClick={newAttempt}
            >
              {needsReview
                ? 'Начать новую попытку'
                : 'Изменить файл или название'}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}