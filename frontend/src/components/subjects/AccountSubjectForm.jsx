import { useEffect, useRef, useState } from 'react';
import { BookOpen, X } from 'lucide-react';
import { subjectApi } from '../../services/subjectApi.js';
import { createSubjectAttempt, prepareSubjectValues } from '../../services/subjectDraft.js';

const fields = ['title', 'description', 'icon', 'tone'];
const colors = [
  { value: 'blue', label: 'Синий' },
  { value: 'purple', label: 'Фиолетовый' },
  { value: 'indigo', label: 'Индиго' },
  { value: 'green', label: 'Зелёный' },
];
const uncertainMessage = 'Не удалось подтвердить создание предмета. Проверь список или повтори тот же запрос. Предмет мог уже сохраниться.';
const editWarning = 'Изменённые данные будут отправлены как новое создание. Сначала проверь список: предыдущий предмет мог сохраниться.';
const messages = {
  SUBJECT_TITLE_EXISTS: 'Предмет с таким названием уже есть. Измени название.',
  VALIDATION_FAILED: 'Проверь отмеченные поля.',
  IDEMPOTENCY_KEY_REUSED: 'Этот запрос уже использован с другими данными. Закрой окно и проверь список предметов.',
  IDEMPOTENCY_EXPIRED: 'Срок безопасного повтора истёк. Закрой окно и проверь список предметов перед новым созданием.',
  REQUEST_IN_PROGRESS: 'Создание ещё выполняется. Подожди и повтори тот же запрос.',
  CSRF_NOT_INITIALIZED: 'Не удалось проверить безопасность формы. Сохрани черновик в этом окне и повтори проверку сессии.',
};

function messageFor(code) {
  return typeof messages[code] === 'string' ? messages[code] : null;
}

function fieldErrors(error) {
  return Object.fromEntries(fields
    .filter((field) => typeof error?.fieldErrors?.[field] === 'string')
    .map((field) => [field, error.fieldErrors[field]]));
}

function isUncertain(error) {
  return ['NETWORK_ERROR', 'INVALID_RESPONSE', 'REQUEST_IN_PROGRESS', 'REQUEST_CANCELLED'].includes(error?.code)
    || error?.status >= 500;
}

export default function AccountSubjectForm({ draftRef, onClose, onCreated, onAccessError }) {
  const [form, setForm] = useState(() => draftRef.current?.values ?? {
    title: '', description: '', icon: 'book', tone: 'blue',
  });
  const [errors, setErrors] = useState({});
  const [uncertain, setUncertain] = useState(Boolean(draftRef.current?.uncertain));
  const [editingUncertain, setEditingUncertain] = useState(Boolean(draftRef.current?.editingUncertain));
  const [expired, setExpired] = useState(Boolean(draftRef.current?.expired));
  const [retryAt, setRetryAt] = useState(draftRef.current?.retryAt ?? 0);
  const [now, setNow] = useState(Date.now);
  const [message, setMessage] = useState(() => draftRef.current?.expired
    ? messages.IDEMPOTENCY_EXPIRED
    : draftRef.current?.uncertain
      ? draftRef.current?.editingUncertain ? editWarning : uncertainMessage
      : '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useRef(null);
  const titleRef = useRef(null);
  const submitRef = useRef(null);
  const requestRef = useRef(null);
  const submitLockRef = useRef(false);
  const errorFocusRef = useRef('');
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const locked = isSubmitting || ((uncertain || expired) && !editingUncertain);

  function saveDraft(changes = {}) {
    draftRef.current = {
      values: form, attempt: null, open: true,
      ...draftRef.current, ...changes,
    };
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';
    if (draftRef.current?.uncertain || draftRef.current?.expired) submitRef.current?.focus();
    else titleRef.current?.focus();

    return () => {
      requestRef.current?.abort();
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [draftRef]);

  useEffect(() => {
    if (retryAt <= Date.now()) return undefined;
    const timer = window.setInterval(() => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (timestamp >= retryAt) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  useEffect(() => {
    if (isSubmitting || !errorFocusRef.current) return;
    const control = dialogRef.current?.querySelector(`[name="${errorFocusRef.current}"]`);
    if (!control?.disabled) control?.focus();
    errorFocusRef.current = '';
  }, [errors, isSubmitting]);

  function close() {
    if (submitLockRef.current) return;
    saveDraft({ open: false });
    onClose();
  }

  function updateField(field, value) {
    if (submitLockRef.current || locked) return;
    const next = { ...form, [field]: value };
    setForm(next);
    saveDraft({ values: next });
    setErrors((current) => ({ ...current, [field]: undefined }));
    if (!uncertain && !expired) setMessage('');
  }

  function enableEditing() {
    if (submitLockRef.current) return;
    setEditingUncertain(true);
    saveDraft({ editingUncertain: true });
    setMessage(editWarning);
    // Focus runs after React enables the field.
    errorFocusRef.current = 'title';
    setErrors({});
  }

  async function submit(event) {
    event.preventDefault();
    if (submitLockRef.current || Date.now() < retryAt || (expired && !editingUncertain)) return;
    let attempt;
    try {
      const values = prepareSubjectValues(form);
      attempt = createSubjectAttempt(values, draftRef.current?.attempt);
    } catch (error) {
      const nextErrors = fieldErrors(error);
      setErrors(nextErrors);
      errorFocusRef.current = fields.find((field) => nextErrors[field]) ?? '';
      if (error.code === 'IDEMPOTENCY_EXPIRED') {
        setExpired(true);
        setEditingUncertain(false);
        saveDraft({ expired: true, editingUncertain: false });
      }
      setMessage(messageFor(error.code) ?? 'Не удалось подготовить создание предмета. Проверь поля формы.');
      return;
    }

    const controller = new AbortController();
    requestRef.current = controller;
    submitLockRef.current = true;
    setIsSubmitting(true);
    setErrors({});
    setMessage('');
    setExpired(false);
    setEditingUncertain(false);
    // Until a definitive response arrives, leaving this component must preserve
    // the original request, including its key, for a safe manual retry.
    saveDraft({ attempt, values: form, uncertain: true, expired: false, editingUncertain: false, retryAt: 0 });
    try {
      await subjectApi.create(attempt.values, {
        idempotencyKey: attempt.key,
        signal: controller.signal,
      });
      if (controller.signal.aborted || draftRef.current?.attempt !== attempt) return;
      draftRef.current = null;
      onCreated();
    } catch (error) {
      if (controller.signal.aborted || draftRef.current?.attempt !== attempt) return;
      if ((error.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
        || (error.status === 403 && error.code === 'CSRF_INVALID')
        || error.code === 'CSRF_NOT_INITIALIZED') {
        saveDraft({ uncertain: false, open: true });
        onAccessError(error);
        return;
      }
      const nextUncertain = isUncertain(error);
      const nextErrors = fieldErrors(error);
      const seconds = Number(error.retryAfterSeconds);
      // There is no automatic retry. Retry-After only disables the manual button.
      const nextRetryAt = Number.isFinite(seconds) && seconds > 0
        ? Date.now() + Math.ceil(Math.min(seconds, 86400)) * 1000 : 0;
      setUncertain(nextUncertain);
      setEditingUncertain(false);
      setRetryAt(nextRetryAt);
      setNow(Date.now());
      setErrors(nextErrors);
      errorFocusRef.current = fields.find((field) => nextErrors[field]) ?? '';
      saveDraft({ uncertain: nextUncertain, editingUncertain: false, retryAt: nextRetryAt });
      setMessage(messageFor(error.code)
        ?? (nextUncertain ? uncertainMessage : 'Не удалось создать предмет. Проверь данные и попробуй ещё раз.'));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        submitLockRef.current = false;
        if (!controller.signal.aborted) setIsSubmitting(false);
      }
    }
  }

  function backdropClick(event) {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  }

  return (
    <dialog ref={dialogRef} className="subject-modal account-subject-form"
      aria-labelledby="account-create-subject-title" aria-describedby="account-create-subject-description"
      onClick={backdropClick} onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="subject-modal-header">
        <span className={`icon-tile tone-${form.tone}`}><BookOpen size={25} aria-hidden="true" /></span>
        <button type="button" className="icon-button" aria-label="Закрыть окно" disabled={isSubmitting} onClick={close}>
          <X size={21} aria-hidden="true" />
        </button>
      </div>
      <h2 id="account-create-subject-title">Новый предмет</h2>
      <p id="account-create-subject-description" className="muted">Добавь предмет и выбери оформление его карточки.</p>
      <form className="subject-form" onSubmit={submit} noValidate aria-busy={isSubmitting}>
        {message && <p className="form-error" role="alert">{message}</p>}
        {(uncertain || expired) && !editingUncertain && (
          <button type="button" className="secondary-button" disabled={isSubmitting} onClick={enableEditing}>Изменить данные</button>
        )}
        <label className="subject-field">
          <span>Название предмета *</span>
          <input ref={titleRef} name="title" type="text" value={form.title} required maxLength={60}
            disabled={locked} onChange={(event) => updateField('title', event.target.value)} placeholder="Например, Физика"
            aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? 'account-subject-title-error' : undefined} />
          {errors.title && <span id="account-subject-title-error" className="form-error">{errors.title}</span>}
        </label>
        <label className="subject-field">
          <span>Описание <small>необязательно</small></span>
          <textarea name="description" rows={3} value={form.description} maxLength={160} disabled={locked}
            onChange={(event) => updateField('description', event.target.value)} placeholder="Что будем изучать?"
            aria-invalid={Boolean(errors.description)}
            aria-describedby={errors.description ? 'account-subject-description-error' : undefined} />
          {errors.description && <span id="account-subject-description-error" className="form-error">{errors.description}</span>}
          <span className="field-hint">{form.description.length}/160</span>
        </label>
        <label className="subject-field">
          <span id="account-subject-icon-label">Иконка карточки</span>
          <select name="icon" value={form.icon} disabled={locked} onChange={(event) => updateField('icon', event.target.value)}
            aria-labelledby="account-subject-icon-label"
            aria-invalid={Boolean(errors.icon)} aria-describedby={errors.icon ? 'account-subject-icon-error' : undefined}>
            <option value="book">Книга</option><option value="database">База данных</option>
            <option value="languages">Языки</option><option value="code">Программирование</option>
          </select>
          {errors.icon && <span id="account-subject-icon-error" className="form-error">{errors.icon}</span>}
        </label>
        <fieldset className="subject-colors" disabled={locked} aria-describedby={errors.tone ? 'account-subject-tone-error' : undefined}>
          <legend>Цвет карточки</legend>
          <div className="subject-color-grid">
            {colors.map((option) => (
              <label key={option.value} className={`subject-color-option tone-${option.value}`}>
                <input type="radio" name="tone" value={option.value} checked={form.tone === option.value}
                  onChange={(event) => updateField('tone', event.target.value)} />
                <span className="subject-color-dot" aria-hidden="true" />{option.label}
              </label>
            ))}
          </div>
          {errors.tone && <span id="account-subject-tone-error" className="form-error">{errors.tone}</span>}
        </fieldset>
        <p className="subject-form-note">Предмет сохранится в твоём аккаунте. Черновик доступен до перезагрузки страницы.</p>
        {remaining > 0 && <p className="subject-form-note" role="status">Повтор будет доступен через {remaining} сек.</p>}
        <div className="subject-form-actions">
          <button type="button" className="secondary-button" disabled={isSubmitting} onClick={close}>Отмена</button>
          <button ref={submitRef} type="submit" className="primary-button"
            disabled={isSubmitting || remaining > 0 || (expired && !editingUncertain)}>
            {isSubmitting ? 'Создаём предмет…' : uncertain && !editingUncertain ? 'Повторить создание' : 'Создать предмет'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
