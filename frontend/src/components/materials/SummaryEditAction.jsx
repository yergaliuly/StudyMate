import { useEffect, useId, useRef, useState } from 'react';
import { Pencil, Save } from 'lucide-react';
import {
  createSummaryEditAction,
  getSummaryEditState,
} from '../../services/summaryEditAction.js';
import '../../styles/summaryEdit.css';

export default function SummaryEditAction({
  materialId, subjectId, record, canAct, canWrite, writeEnabled,
  onRead, onSaved, onAccessError, onStateChange,
}) {
  const id = useId();
  const inputRef = useRef(null);
  const openerRef = useRef(null);
  const reviewRef = useRef(null);
  const serverChoiceRef = useRef(null);
  const actionRef = useRef(null);
  const callbacks = useRef({});
  callbacks.current = { canAct, canWrite, onRead, onSaved, onAccessError, onStateChange };
  const [state, setState] = useState(() => getSummaryEditState(record, materialId));
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    const action = createSummaryEditAction({
      record, materialId, subjectId,
      canAct: (value) => active && callbacks.current.canAct(value),
      canWrite: () => callbacks.current.canWrite(),
      onChange: (next) => {
        if (!active) return;
        setState(next);
        setNow(Date.now());
        callbacks.current.onStateChange(next);
      },
      onRead: (value) => callbacks.current.onRead(value),
      onSaved: (value) => callbacks.current.onSaved(value),
      onAccessError: (error) => callbacks.current.onAccessError(error),
    });
    actionRef.current = action;
    const savedState = getSummaryEditState(record, materialId);
    setState(savedState);
    callbacks.current.onStateChange(savedState);
    if (savedState.open) void action.review();
    return () => {
      active = false;
      action.stop();
      if (actionRef.current === action) actionRef.current = null;
    };
  }, [record, materialId, subjectId]);

  useEffect(() => {
    const timestamp = Date.now();
    setNow(timestamp);
    if (state.retryAt <= timestamp) return undefined;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= state.retryAt) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [state.retryAt]);

  const busy = state.pending || state.reading;
  const locked = busy || Boolean(state.gate) || state.unavailable
    || state.baseVersion === null || !writeEnabled;
  const remaining = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const needsReview = state.gate === 'conflict' || state.gate === 'uncertain'
    || state.unavailable || (state.baseVersion === null && !state.latest);
  const canReview = state.open && !busy && remaining === 0 && needsReview;

  useEffect(() => {
    if (state.open && !locked) inputRef.current?.focus();
  }, [state.open, locked, state.fieldError]);
  useEffect(() => {
    if (state.open && !busy && state.gate === 'review' && writeEnabled) serverChoiceRef.current?.focus();
  }, [state.open, busy, state.gate, state.latest?.version, writeEnabled]);
  useEffect(() => {
    if (canReview) reviewRef.current?.focus();
  }, [canReview]);

  if (!canAct(materialId)) return null;

  return (
    <div className="summary-edit">
      {!state.open ? (
        <>
          <button
            ref={openerRef}
            type="button"
            className="secondary-button"
            aria-expanded={false}
            disabled={!writeEnabled || busy || remaining > 0}
            onClick={() => { void actionRef.current?.open(); }}
          >
            <Pencil size={17} aria-hidden="true" />
            Редактировать конспект
          </button>
          {state.message && <p className="material-summary-hint" role="status">{state.message}</p>}
        </>
      ) : (
        <form
          className="summary-edit-form"
          aria-label="Редактирование конспекта"
          aria-busy={busy}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void actionRef.current?.save();
          }}
        >
          <h4>Редактирование конспекта</h4>
          {state.reading && <p className="material-summary-hint" role="status">Загружаем актуальный конспект…</p>}
          {state.message && <p className="material-summary-hint" role="alert">{state.message}</p>}

          <div className="summary-edit-field">
            <label htmlFor={id}>Текст конспекта</label>
            <textarea
              ref={inputRef}
              id={id}
              name="content"
              required
              rows={12}
              value={state.content}
              disabled={locked}
              aria-invalid={Boolean(state.fieldError)}
              aria-describedby={id + '-hint' + (state.fieldError ? ' ' + id + '-error' : '')}
              onChange={(event) => actionRef.current?.changeContent(event.target.value)}
            />
            <p className="material-summary-hint" id={id + '-hint'}>
              До 100 000 символов. Переносы строк сохраняются, пробелы в начале и конце
              убираются сервером. Черновик хранится до выхода из аккаунта или перезагрузки страницы.
            </p>
            {state.fieldError && <p className="form-error" id={id + '-error'} role="alert">{state.fieldError}</p>}
          </div>

          {!state.reading && needsReview && (
            <div className="summary-edit-actions">
              <button
                ref={reviewRef}
                type="button"
                className="secondary-button"
                disabled={state.pending || remaining > 0}
                onClick={() => { void actionRef.current?.review(); }}
              >
                {state.gate === 'uncertain' ? 'Проверить сохранение' : 'Загрузить актуальную версию'}
              </button>
            </div>
          )}

          {state.gate === 'review' && state.latest && (
            <section className="summary-edit-review" aria-label="Сравнение конспектов">
              <div className="summary-edit-comparison">
                <div>
                  <h4>На сервере</h4>
                  <span className="material-summary-hint">Версия {state.latest.version}</span>
                  <pre>{state.latest.content}</pre>
                </div>
                <div>
                  <h4>Твой черновик</h4>
                  <pre>{state.content}</pre>
                </div>
              </div>
              <p className="material-summary-hint">
                Выбери текст для редактора. Изменения отправятся только по кнопке
                «Сохранить конспект» и заменят текущую серверную версию.
              </p>
              <div className="summary-edit-actions">
                <button
                  ref={serverChoiceRef}
                  type="button"
                  className="secondary-button"
                  disabled={busy || remaining > 0 || !writeEnabled}
                  onClick={() => actionRef.current?.chooseVersion(true)}
                >Использовать версию сервера</button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || remaining > 0 || !writeEnabled}
                  onClick={() => actionRef.current?.chooseVersion(false)}
                >Продолжить с моим черновиком</button>
              </div>
            </section>
          )}

          {remaining > 0 && <p className="material-summary-hint" role="status">Повтор доступен через {remaining} сек.</p>}
          {!writeEnabled && !busy && <p className="material-summary-hint" role="status">
            Редактирование станет доступно после проверки состояния и завершения генерации.
          </p>}
          <div className="summary-edit-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={state.pending}
              onClick={() => {
                actionRef.current?.close();
                window.requestAnimationFrame(() => {
                  if (callbacks.current.canAct(materialId)) openerRef.current?.focus({ preventScroll: true });
                });
              }}
            >Скрыть редактор</button>
            <button type="submit" className="primary-button" disabled={locked || remaining > 0}>
              <Save size={17} aria-hidden="true" />
              {state.pending ? 'Сохраняем конспект…' : 'Сохранить конспект'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
