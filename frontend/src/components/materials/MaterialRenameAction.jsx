import { useEffect, useId, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import {
  createMaterialRenameAction,
  getMaterialRenameState,
} from '../../services/materialRenameAction.js';
import '../../styles/materialRename.css';

export default function MaterialRenameAction({
  material,
  subjectId,
  record,
  canAct,
  onRead,
  onSaved,
  onAccessError,
}) {
  const id = useId();
  const inputRef = useRef(null);
  const openerRef = useRef(null);
  const serverChoiceRef = useRef(null);
  const reviewRef = useRef(null);
  const actionRef = useRef(null);
  const callbacks = useRef({});
  callbacks.current = { canAct, onRead, onSaved, onAccessError };

  const [state, setState] = useState(() => getMaterialRenameState(record, material.id));
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    const action = createMaterialRenameAction({
      record,
      materialId: material.id,
      subjectId,
      canAct: (materialId) => active && callbacks.current.canAct(materialId),
      onChange: (next) => {
        if (!active) return;
        setState(next);
        setNow(Date.now());
      },
      onSaved: (fresh) => callbacks.current.onSaved(fresh),
      onRead: (fresh) => callbacks.current.onRead?.(fresh),
      onAccessError: (error) => callbacks.current.onAccessError(error),
    });

    actionRef.current = action;
    const savedState = getMaterialRenameState(record, material.id);
    setState(savedState);
    if (savedState.open) void action.open();

    return () => {
      active = false;
      action.stop();
      if (actionRef.current === action) actionRef.current = null;
    };
  }, [record, material.id, subjectId]);

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
  const locked = busy || Boolean(state.gate) || state.unavailable || state.baseVersion === null;
  const remaining = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const canReview = state.open && !busy && remaining === 0
    && (state.gate === 'conflict' || state.gate === 'uncertain'
      || state.unavailable || state.baseVersion === null)
    && state.gate !== 'review';

  useEffect(() => {
    if (state.open && !locked) inputRef.current?.focus();
  }, [state.open, locked, state.fieldError]);

  useEffect(() => {
    if (state.open && !busy && state.gate === 'review') serverChoiceRef.current?.focus();
  }, [state.open, busy, state.gate, state.latest?.version]);

  useEffect(() => {
    if (canReview) reviewRef.current?.focus();
  }, [canReview]);

  if (!canAct(material.id) || material.status !== 'stored') return null;

  return (
    <div className="material-rename" role="group" aria-label="Переименование материала">
      {!state.open ? (
        <>
          <button
            ref={openerRef}
            type="button"
            className="secondary-button"
            aria-expanded={false}
            onClick={() => { void actionRef.current?.open(); }}
          >
            <Pencil size={17} aria-hidden="true" />
            Переименовать материал
          </button>
          {state.message && <p className="material-text-hint" role="status">{state.message}</p>}
        </>
      ) : (
        <form
          className="material-rename-form"
          aria-label="Переименование материала"
          aria-busy={busy}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void actionRef.current?.save();
          }}
        >
          {state.reading && (
            <p className="material-text-hint" role="status">Загружаем актуальное название…</p>
          )}

          {state.message && (
            <p className="material-text-hint" role="alert">{state.message}</p>
          )}

          <div className="material-rename-field">
            <label htmlFor={id}>Название материала</label>
            <input
              ref={inputRef}
              id={id}
              name="title"
              type="text"
              required
              value={state.title}
              disabled={locked}
              aria-invalid={Boolean(state.fieldError)}
              aria-describedby={state.fieldError ? id + '-error' : id + '-hint'}
              onChange={(event) => actionRef.current?.changeTitle(event.target.value)}
            />
            <p className="material-text-hint" id={id + '-hint'}>
              От 1 до 160 символов. Лишние пробелы убираются при сохранении.
            </p>
            {state.fieldError && (
              <p className="form-error" id={id + '-error'} role="alert">{state.fieldError}</p>
            )}
          </div>

          {!state.reading && (state.gate === 'conflict'
            || state.gate === 'uncertain'
            || state.unavailable
            || state.baseVersion === null) && (
            <div className="material-rename-actions">
              <button
                ref={reviewRef}
                type="button"
                className="secondary-button"
                disabled={state.pending || remaining > 0}
                onClick={() => { void actionRef.current?.review(); }}
              >
                {state.gate === 'uncertain' ? 'Проверить результат' : 'Загрузить актуальную версию'}
              </button>
            </div>
          )}

          {state.gate === 'review' && state.latest && (
            <section className="material-rename-review" aria-label="Сравнение названий">
              <div className="material-rename-comparison">
                <div>
                  <h4>На сервере</h4>
                  <p>{state.latest.title}</p>
                </div>
                <div>
                  <h4>Твой черновик</h4>
                  <p>{state.title}</p>
                </div>
              </div>
              <p className="material-text-hint">
                Выбор не отправляет изменения. После выбора черновика следующее
                сохранение заменит актуальное название на сервере.
              </p>
              <div className="material-rename-actions">
                <button
                  ref={serverChoiceRef}
                  type="button"
                  className="secondary-button"
                  disabled={busy || remaining > 0}
                  onClick={() => actionRef.current?.chooseVersion(true)}
                >
                  Использовать версию сервера
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || remaining > 0}
                  onClick={() => actionRef.current?.chooseVersion(false)}
                >
                  Продолжить с моим черновиком
                </button>
              </div>
            </section>
          )}

          {remaining > 0 && (
            <p className="material-text-hint" role="status">
              Повтор доступен через {remaining} сек.
            </p>
          )}

          <div className="material-rename-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={state.pending}
              onClick={() => {
                actionRef.current?.close();
                window.requestAnimationFrame(() => {
                  if (callbacks.current.canAct(material.id)) openerRef.current?.focus();
                });
              }}
            >
              Скрыть форму
            </button>
            <button type="submit" className="primary-button" disabled={locked || remaining > 0}>
              {state.pending ? 'Сохраняем название…' : 'Сохранить название'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
