import { useEffect, useRef, useState } from 'react';
import { BookOpen, Code, Database, Languages, Pencil, Trash2, X } from 'lucide-react';
import { subjectApi } from '../../services/subjectApi.js';
import { prepareSubjectValues } from '../../services/subjectDraft.js';
import { isRateLimited, retrySeconds } from '../../services/retryAfter.js';
import { useRetryCooldown } from '../../hooks/useRetryCooldown.js';
import '../../styles/subjectDetails.css';

const fields = ['title', 'description', 'icon', 'tone'];
const icons = { book: BookOpen, database: Database, languages: Languages, code: Code };
const iconNames = { book: 'Книга', database: 'База данных', languages: 'Языки', code: 'Программирование' };
const colors = { blue: 'Синий', purple: 'Фиолетовый', indigo: 'Индиго', green: 'Зелёный' };
const unavailableMessage = 'Предмет недоступен. Возможно, он удалён или у тебя больше нет доступа.';
const conflictMessage = 'Предмет изменился после открытия формы. Твой черновик сохранён. Загрузи актуальную версию и выбери, какие данные оставить.';
const unknownPatchMessage = 'Не удалось подтвердить сохранение. Изменения могли примениться. Проверь результат перед следующим сохранением.';
const unknownDeleteMessage = 'Не удалось подтвердить удаление. Предмет мог быть удалён. Проверь результат перед повторным действием.';
const rateLimitMessage = 'Слишком много запросов. Подожди перед повтором. Данные формы сохранены.';

function valuesOf(subject) {
  return Object.fromEntries(fields.map((field) => [field, subject[field]]));
}

function errorsOf(error) {
  return Object.fromEntries(fields
    .filter((field) => typeof error?.fieldErrors?.[field] === 'string')
    .map((field) => [field, error.fieldErrors[field]]));
}

function accessError(error) {
  return (error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
    || (error?.status === 403 && error.code === 'CSRF_INVALID')
    || error?.code === 'CSRF_NOT_INITIALIZED';
}

function uncertainError(error) {
  return ['NETWORK_ERROR', 'INVALID_RESPONSE', 'REQUEST_CANCELLED'].includes(error?.code)
    || error?.status >= 500;
}

function sameValues(first, second) {
  try {
    return JSON.stringify(prepareSubjectValues(first)) === JSON.stringify(prepareSubjectValues(second));
  } catch {
    return false;
  }
}

function snapshot(record) {
  return {
    mode: record.mode ?? 'view', subject: record.subject ?? null,
    draft: record.draft ?? null, baseVersion: record.baseVersion ?? null,
    gate: record.gate ?? '', latest: record.latest ?? null,
    unavailable: Boolean(record.unavailable), message: record.message ?? '',
    errors: record.errors ?? {}, readFailed: Boolean(record.readFailed),
  };
}

function ComparedValues({ title, values }) {
  return (
    <section className="subject-detail-comparison-card" aria-label={title}>
      <h4>{title}</h4>
      <dl>
        <dt>Название</dt><dd>{values.title}</dd>
        <dt>Описание</dt><dd>{values.description || 'Без описания'}</dd>
        <dt>Иконка</dt><dd>{iconNames[values.icon]}</dd>
        <dt>Цвет</dt><dd>{colors[values.tone]}</dd>
      </dl>
    </section>
  );
}

export default function AccountSubjectDetails({
  detailRef,
  onClose,
  onChanged,
  onAccessError,
  onAccessRestored,
  onOpenMaterials,
}) {
  const recordRef = useRef(detailRef.current);
  const record = recordRef.current;
  const [state, setState] = useState(() => snapshot(record));
  const [busy, setBusy] = useState(() => retrySeconds(record.retryAt ?? 0) > 0 ? '' : 'read');
  const dialogRef = useRef(null);
  const headingRef = useRef(null);
  const cancelRef = useRef(null);
  const requestRef = useRef(null);
  const mutationLockRef = useRef(false);
  const mountedRef = useRef(false);
  const focusFieldRef = useRef('');
  const retryReadRef = useRef('initial');
  const callbacksRef = useRef({ onClose, onChanged, onAccessError, onAccessRestored });
  callbacksRef.current = { onClose, onChanged, onAccessError, onAccessRestored };
  const cooldown = useRetryCooldown({
    initialRetryAt: record.retryAt ?? 0,
    onChange: (deadline) => { if (active()) record.retryAt = deadline; },
  });

  function active() {
    return mountedRef.current && detailRef.current === record;
  }

  function update(changes) {
    if (!active()) return;
    Object.assign(record, changes);
    setState(snapshot(record));
  }

  function begin(kind) {
    if (!active() || mutationLockRef.current || cooldown.isBlocked()) return null;
    requestRef.current?.controller.abort();
    const operation = { kind, controller: new AbortController() };
    requestRef.current = operation;
    mutationLockRef.current = kind !== 'read';
    setBusy(kind);
    return operation;
  }

  function current(operation) {
    return active() && requestRef.current === operation && !operation.controller.signal.aborted;
  }

  function finish(operation) {
    if (requestRef.current !== operation) return;
    requestRef.current = null;
    mutationLockRef.current = false;
    if (active()) setBusy('');
  }

  function unavailable() {
    update({ unavailable: true, gate: '', latest: null, readFailed: false, message: unavailableMessage, errors: {} });
    callbacksRef.current.onChanged('Предмет недоступен. Список предметов обновляется.');
  }

  function handleAccess(error) {
    // The record is mutated in place. A removed account record is never recreated.
    update({ errors: {}, message: 'Черновик сохранён. Проверь доступ к аккаунту и продолжи вручную.' });
    callbacksRef.current.onAccessError(error);
  }

  async function load(purpose = 'initial') {
    const operation = begin('read');
    if (!operation) return;
    retryReadRef.current = purpose;
    update({ readFailed: false, errors: {} });
    try {
      const subject = await subjectApi.getById(record.id, { signal: operation.controller.signal });
      if (!current(operation)) return;
      callbacksRef.current.onAccessRestored?.();
      if (!current(operation)) return;
      if (purpose === 'review') {
        const matches = sameValues(subject, record.draft);
        update({ subject, latest: subject, gate: 'review', unavailable: false,
          message: matches
            ? 'Сейчас на сервере сохранены такие же данные, как в твоём черновике. Выбери, какие данные оставить в форме.'
            : 'Сравни актуальные данные с черновиком. Выбор не отправляет изменения на сервер.' });
      } else if (purpose === 'check-delete' || record.gate === 'delete-unknown') {
        update({ mode: 'view', subject, gate: '', latest: null, unavailable: false,
          message: 'Предмет доступен на сервере. Для удаления открой подтверждение ещё раз.' });
        callbacksRef.current.onChanged('Состояние предмета обновлено.');
      } else if (record.mode === 'edit') {
        if (record.draft && record.baseVersion !== null && record.baseVersion !== undefined) {
          const needsReview = Boolean(record.gate) || subject.version !== record.baseVersion;
          update({ subject, unavailable: false, message: '',
            ...(needsReview ? { latest: subject, gate: 'review',
              message: 'Черновик сохранён. Сравни его с актуальными данными перед сохранением.' } : {}),
          });
        } else {
          update({ subject, draft: valuesOf(subject), baseVersion: subject.version,
            gate: '', latest: null, unavailable: false, message: '' });
        }
        focusFieldRef.current = 'title';
      } else {
        update({ subject, unavailable: false, gate: '', latest: null, message: '' });
      }
    } catch (error) {
      if (!current(operation)) return;
      if (accessError(error)) handleAccess(error);
      else if (error.status === 404 && error.code === 'SUBJECT_NOT_FOUND') unavailable();
      else if (isRateLimited(error)) {
        cooldown.remember(error);
        update({ readFailed: true, message: rateLimitMessage });
      }
      else update({ readFailed: true, message: 'Не удалось загрузить предмет. Проверь соединение и повтори загрузку.' });
    } finally {
      finish(operation);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';
    if (record.mode === 'delete') cancelRef.current?.focus();
    else headingRef.current?.focus();
    if (cooldown.isBlocked()) {
      // Reopening must not bypass the deadline or trust a stale editable version.
      update({ readFailed: true, message: rateLimitMessage });
    } else load('initial');
    return () => {
      mountedRef.current = false;
      requestRef.current?.controller.abort();
      requestRef.current = null;
      mutationLockRef.current = false;
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      else document.getElementById('account-main-content')?.focus();
    };
  }, [detailRef, record]);

  useEffect(() => {
    if (busy) return;
    if (state.mode === 'delete') cancelRef.current?.focus();
    else if (focusFieldRef.current) {
      const input = dialogRef.current?.querySelector(`[name="${focusFieldRef.current}"]`);
      if (input && !input.disabled) input.focus();
    }
    focusFieldRef.current = '';
  }, [busy, state.mode, state.errors]);

  function close() {
    if (!active() || mutationLockRef.current) return;
    requestRef.current?.controller.abort();
    callbacksRef.current.onClose();
  }

  function enter(mode) {
    if (!active() || mutationLockRef.current || busy || record.readFailed || cooldown.isBlocked()) return;
    update({ mode, draft: null, baseVersion: null, gate: '', latest: null, errors: {}, message: '' });
    load(mode);
  }

  function changeField(field, value) {
    if (!active() || mutationLockRef.current || busy || record.gate || record.unavailable) return;
    update({ draft: { ...record.draft, [field]: value },
      errors: { ...record.errors, [field]: undefined }, message: '' });
  }

  function chooseVersion(useServer) {
    if (!active() || mutationLockRef.current || busy || !record.latest) return;
    update({ draft: useServer ? valuesOf(record.latest) : record.draft,
      subject: record.latest, baseVersion: record.latest.version, latest: null, gate: '', errors: {},
      message: useServer ? 'В форму загружены данные сервера. Изменения отправятся только после сохранения.'
        : 'При следующем сохранении твой черновик заменит название, описание и оформление на сервере.' });
    focusFieldRef.current = 'title';
  }

  async function save(event) {
    event.preventDefault();
    if (!active() || mutationLockRef.current || busy || record.gate || record.readFailed || record.unavailable || !record.draft || cooldown.isBlocked()) return;
    let values;
    try {
      values = prepareSubjectValues(record.draft);
    } catch (error) {
      const errors = errorsOf(error);
      focusFieldRef.current = fields.find((field) => errors[field]) ?? 'title';
      update({ errors, message: 'Проверь отмеченные поля.' });
      return;
    }
    const operation = begin('patch');
    if (!operation) return;
    const version = record.baseVersion;
    // If the component disappears before a response, resuming requires a GET
    // and an explicit choice. A mutation is never repeated automatically.
    update({ gate: 'patch-unknown', latest: null, errors: {}, message: '' });
    try {
      const subject = await subjectApi.update(record.id, values, { version, signal: operation.controller.signal });
      if (!current(operation)) return;
      record.retryAt = 0;
      update({ subject, mode: 'view', draft: null, baseVersion: null, gate: '', latest: null,
        message: 'Изменения сохранены.' });
      callbacksRef.current.onChanged('Изменения сохранены.');
    } catch (error) {
      if (!current(operation)) return;
      if (accessError(error)) {
        update({ gate: '' });
        handleAccess(error);
      } else if (error.status === 404 && error.code === 'SUBJECT_NOT_FOUND') unavailable();
      else if (isRateLimited(error)) {
        cooldown.remember(error);
        update({ gate: '', errors: {}, message: rateLimitMessage });
      }
      else if (error.code === 'SUBJECT_VERSION_CONFLICT') update({ gate: 'conflict', message: conflictMessage });
      else if (uncertainError(error)) update({ gate: 'patch-unknown', message: unknownPatchMessage });
      else {
        const errors = errorsOf(error);
        focusFieldRef.current = fields.find((field) => errors[field]) ?? (error.code === 'SUBJECT_TITLE_EXISTS' ? 'title' : '');
        update({ gate: '', errors, message: error.code === 'SUBJECT_TITLE_EXISTS'
          ? 'Предмет с таким названием уже есть. Измени название.'
          : error.code === 'VALIDATION_FAILED' ? 'Проверь отмеченные поля.'
            : 'Не удалось сохранить предмет. Проверь данные и попробуй ещё раз.' });
      }
    } finally {
      finish(operation);
    }
  }

  async function remove() {
    if (!active() || mutationLockRef.current || busy || record.gate || record.readFailed || record.unavailable || !record.subject || cooldown.isBlocked()) return;
    const operation = begin('delete');
    if (!operation) return;
    update({ gate: 'delete-unknown', errors: {}, message: '' });
    try {
      await subjectApi.remove(record.id, { signal: operation.controller.signal });
      if (!current(operation)) return;
      record.retryAt = 0;
      callbacksRef.current.onChanged('Предмет удалён.');
      callbacksRef.current.onClose();
    } catch (error) {
      if (!current(operation)) return;
      if (accessError(error)) {
        update({ gate: '' });
        handleAccess(error);
      } else if (error.status === 404 && error.code === 'SUBJECT_NOT_FOUND') unavailable();
      else if (isRateLimited(error)) {
        cooldown.remember(error);
        update({ gate: '', message: rateLimitMessage });
      }
      else if (error.code === 'SUBJECT_NOT_EMPTY') update({ gate: '',
        message: 'Предмет нельзя удалить: с ним связаны материалы, их обработка или очистка. Дождись завершения и проверь материалы.' });
      else if (uncertainError(error)) update({ gate: 'delete-unknown', message: unknownDeleteMessage });
      else update({ gate: '', message: 'Не удалось удалить предмет. Попробуй ещё раз позже.' });
    } finally {
      finish(operation);
    }
  }

  function backdropClick(event) {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  }

  const title = state.mode === 'edit' ? 'Редактировать предмет' : state.mode === 'delete' ? 'Удалить предмет?' : 'Предмет';
  const mutationPending = busy === 'patch' || busy === 'delete';
  const formLocked = Boolean(busy || state.gate || state.readFailed || state.unavailable);
  const SubjectIcon = icons[state.subject?.icon] ?? BookOpen;
  const canShowContent = !state.unavailable && state.subject && busy !== 'read';

  return (
    <dialog ref={dialogRef} className="subject-modal account-subject-details"
      aria-labelledby="account-subject-details-title" onClick={backdropClick}
      onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="subject-modal-header">
        <span className={`icon-tile tone-${state.subject?.tone ?? 'blue'}`}>
          <SubjectIcon size={25} aria-hidden="true" />
        </span>
        <button type="button" className="icon-button" aria-label="Закрыть окно" disabled={mutationPending} onClick={close}>
          <X size={21} aria-hidden="true" />
        </button>
      </div>
      <h2 ref={headingRef} tabIndex={-1} id="account-subject-details-title">{title}</h2>
      {busy === 'read' && <p className="subject-detail-notice" role="status">Загружаем предмет…</p>}
      {state.message && <p className="subject-detail-notice" role={state.gate || state.readFailed || Object.keys(state.errors).length ? 'alert' : 'status'}>{state.message}</p>}
      {cooldown.blocked && <p className="subject-detail-notice" role="status">Повтор будет доступен через {cooldown.seconds} сек.</p>}
      {state.unavailable && <h3 className="subject-detail-unavailable">Предмет недоступен</h3>}
      {state.readFailed && <button type="button" className="secondary-button" disabled={Boolean(busy) || cooldown.blocked} onClick={() => load(retryReadRef.current)}>Повторить загрузку</button>}

      {canShowContent && state.mode === 'view' && (
        <div className="subject-detail-view">
          <h3>{state.subject.title}</h3>
          <p className="subject-detail-description">{state.subject.description || 'Описание пока не добавлено.'}</p>
          <dl className="subject-detail-meta">
            <div><dt>Иконка</dt><dd>{iconNames[state.subject.icon]}</dd></div>
            <div><dt>Цвет</dt><dd>{colors[state.subject.tone]}</dd></div>
            <div><dt>Лекции</dt><dd>{state.subject.lectures}</dd></div>
          </dl>
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(busy || state.readFailed) || cooldown.blocked}
            onClick={() => onOpenMaterials(state.subject.id)}
          >
            Материалы предмета
          </button>
          <div className="subject-detail-actions">
            <button type="button" className="secondary-button" disabled={Boolean(busy || state.readFailed) || cooldown.blocked} onClick={() => enter('edit')}><Pencil size={16} aria-hidden="true" />Редактировать предмет</button>
            <button type="button" className="secondary-button subject-detail-delete-link" disabled={Boolean(busy || state.readFailed) || cooldown.blocked} onClick={() => enter('delete')}><Trash2 size={16} aria-hidden="true" />Удалить предмет</button>
          </div>
        </div>
      )}

      {canShowContent && state.mode === 'edit' && state.draft && (
        <form className="subject-form" onSubmit={save} noValidate aria-busy={busy === 'patch'}>
          {state.gate === 'conflict' && <button type="button" className="secondary-button" disabled={Boolean(busy) || cooldown.blocked} onClick={() => load('review')}>Загрузить актуальную версию</button>}
          {state.gate === 'patch-unknown' && <button type="button" className="secondary-button" disabled={Boolean(busy) || cooldown.blocked} onClick={() => load('review')}>Проверить результат</button>}
          {state.gate === 'review' && state.latest && (
            <section className="subject-detail-review" aria-labelledby="account-subject-review-heading">
              <h3 id="account-subject-review-heading">Сравнение изменений</h3>
              <div className="subject-detail-comparison">
                <ComparedValues title="На сервере" values={state.latest} />
                <ComparedValues title="Твой черновик" values={state.draft} />
              </div>
              <p className="subject-form-note">Если продолжить с черновиком, следующее сохранение заменит название, описание и оформление на сервере. Автоматического сохранения нет.</p>
              <div className="subject-detail-review-actions">
                <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => chooseVersion(true)}>Использовать версию сервера</button>
                <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => chooseVersion(false)}>Продолжить с моим черновиком</button>
              </div>
            </section>
          )}
          <div className="subject-field">
            <label id="account-edit-title-label" htmlFor="account-edit-title">Название предмета *</label>
            <input id="account-edit-title" name="title" value={state.draft.title} required maxLength={60}
              aria-labelledby="account-edit-title-label" disabled={formLocked} onChange={(event) => changeField('title', event.target.value)}
              aria-invalid={Boolean(state.errors.title)} aria-describedby={state.errors.title ? 'account-edit-title-error' : undefined} />
            {state.errors.title && <span className="form-error" id="account-edit-title-error">{state.errors.title}</span>}
          </div>
          <div className="subject-field">
            <label id="account-edit-description-label" htmlFor="account-edit-description">Описание</label>
            <textarea id="account-edit-description" name="description" rows={3} value={state.draft.description} maxLength={160}
              aria-labelledby="account-edit-description-label" disabled={formLocked} onChange={(event) => changeField('description', event.target.value)}
              aria-invalid={Boolean(state.errors.description)} aria-describedby={state.errors.description ? 'account-edit-description-error' : undefined} />
            {state.errors.description && <span className="form-error" id="account-edit-description-error">{state.errors.description}</span>}
            <span className="field-hint">{state.draft.description.length}/160</span>
          </div>
          <div className="subject-field">
            <label id="account-edit-icon-label" htmlFor="account-edit-icon">Иконка карточки</label>
            <select id="account-edit-icon" name="icon" value={state.draft.icon} aria-labelledby="account-edit-icon-label"
              disabled={formLocked} onChange={(event) => changeField('icon', event.target.value)}
              aria-invalid={Boolean(state.errors.icon)} aria-describedby={state.errors.icon ? 'account-edit-icon-error' : undefined}>
              {Object.entries(iconNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {state.errors.icon && <span className="form-error" id="account-edit-icon-error">{state.errors.icon}</span>}
          </div>
          <fieldset className="subject-colors" disabled={formLocked} aria-describedby={state.errors.tone ? 'account-edit-tone-error' : undefined}>
            <legend>Цвет карточки</legend>
            <div className="subject-color-grid">{Object.entries(colors).map(([value, label]) => (
              <label key={value} className={`subject-color-option tone-${value}`}>
                <input type="radio" name="tone" value={value} checked={state.draft.tone === value} onChange={(event) => changeField('tone', event.target.value)} />
                <span className="subject-color-dot" aria-hidden="true" />{label}
              </label>
            ))}</div>
            {state.errors.tone && <span className="form-error" id="account-edit-tone-error">{state.errors.tone}</span>}
          </fieldset>
          <div className="subject-form-actions">
            <button ref={cancelRef} type="button" className="secondary-button" disabled={mutationPending} onClick={close}>Отмена</button>
            <button type="submit" className="primary-button" disabled={formLocked || cooldown.blocked}>{busy === 'patch' ? 'Сохраняем…' : 'Сохранить изменения'}</button>
          </div>
        </form>
      )}

      {canShowContent && state.mode === 'delete' && (
        <div className="subject-detail-delete">
          <p>Предмет <strong>«{state.subject.title}»</strong> будет удалён из твоего аккаунта на сервере. Отменить удаление нельзя.</p>
          <p className="subject-form-note">Предмет со связанными материалами удалить нельзя. Возможность удаления проверяет сервер.</p>
          {state.gate === 'delete-unknown' && <button type="button" className="secondary-button" disabled={Boolean(busy) || cooldown.blocked} onClick={() => load('check-delete')}>Проверить результат</button>}
          <div className="subject-form-actions">
            <button ref={cancelRef} type="button" className="secondary-button" disabled={mutationPending} onClick={close}>Отмена</button>
            <button type="button" className="danger-button" disabled={Boolean(busy || state.gate || state.readFailed) || cooldown.blocked} onClick={remove}>
              <Trash2 size={16} aria-hidden="true" />{busy === 'delete' ? 'Удаляем…' : 'Удалить предмет'}
            </button>
          </div>
        </div>
      )}
      {(state.mode === 'view' || state.unavailable || !canShowContent || (state.mode === 'edit' && !state.draft)) && (
        <div className="subject-form-actions">
          <button ref={cancelRef} type="button" className="secondary-button" disabled={mutationPending} onClick={close}>{state.mode === 'delete' ? 'Отмена' : 'Закрыть'}</button>
        </div>
      )}
    </dialog>
  );
}
