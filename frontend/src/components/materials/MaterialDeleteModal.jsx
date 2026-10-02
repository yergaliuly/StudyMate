import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCw, Trash2, X } from 'lucide-react';
import {
  createMaterialDeleteAction,
  getMaterialDeleteState,
} from '../../services/materialDeleteAction.js';
import '../../styles/materialDelete.css';

export default function MaterialDeleteModal({
  materialId,
  subjectId,
  record,
  canAct,
  onClose,
  onRead,
  onAccepted,
  onRemoved,
  onAccessError,
}) {
  const id = useId();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const actionRef = useRef(null);
  const callbacks = useRef({});
  callbacks.current = { canAct, onClose, onRead, onAccepted, onRemoved, onAccessError };

  const [state, setState] = useState(() => getMaterialDeleteState(record, materialId));
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    const action = createMaterialDeleteAction({
      record,
      materialId,
      subjectId,
      canAct: (value) => active && callbacks.current.canAct(value),
      onChange: (next) => {
        if (!active) return;
        setState(next);
        setNow(Date.now());
      },
      onRead: (material) => callbacks.current.onRead?.(material),
      onAccepted: () => callbacks.current.onAccepted?.(),
      onRemoved: () => callbacks.current.onRemoved?.(),
      onAccessError: (error) => callbacks.current.onAccessError(error),
    });
    actionRef.current = action;
    void action.open();

    return () => {
      active = false;
      action.stop();
      if (actionRef.current === action) actionRef.current = null;
    };
  }, [record, materialId, subjectId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';
    cancelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

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
  const remaining = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const confirming = state.phase === 'confirm';
  const retrying = state.phase === 'failed';
  const reviewing = ['uncertain', 'paused', 'error'].includes(state.phase);
  const watching = state.phase === 'watching';

  function close() {
    if (!callbacks.current.canAct(materialId)) return;
    actionRef.current?.stop();
    callbacks.current.onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="subject-modal material-delete-modal"
      aria-labelledby={id + '-heading'}
      aria-describedby={id + '-warning'}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="subject-modal-header">
        <span className="icon-tile danger-icon">
          <Trash2 size={24} aria-hidden="true" />
        </span>
        <button type="button" className="icon-button" onClick={close} aria-label="Закрыть окно удаления">
          <X size={21} aria-hidden="true" />
        </button>
      </div>

      <h2 id={id + '-heading'}>Удаление материала</h2>

      {state.material && (
        <div className="material-delete-file">
          <p><strong>«{state.material.title}»</strong></p>
          <p>{state.material.fileName}</p>
        </div>
      )}

      <p className="material-delete-warning" id={id + '-warning'}>
        Материал и связанные конспекты, тесты и история попыток будут удалены.
        {' '}Отменить удаление нельзя.
      </p>

      <div className="material-delete-state" aria-busy={busy}>
        {state.reading && <p role="status">Проверяем состояние материала…</p>}

        {watching && (
          <div role="status">
            <h3>Удаление выполняется</h3>
            <p>{state.jobStatus === 'running'
              ? 'Очищаем файл и связанные данные…' : 'Ожидаем начала очистки…'}</p>
          </div>
        )}

        {state.message && (
          <p role={reviewing || retrying ? 'alert' : 'status'}>{state.message}</p>
        )}

        {state.phase !== 'done' && (
          <p className="material-delete-hint">
            Пока очистка не завершена, материал занимает место в хранилище.
          </p>
        )}

        {remaining > 0 && (
          <p className="material-delete-hint" role="status">
            Повтор доступен через {remaining} сек.
          </p>
        )}
      </div>

      {!confirming && state.phase !== 'done' && (
        <p className="material-delete-hint">
          Закрытие окна останавливает проверку, но не отменяет удаление.
        </p>
      )}

      <div className="subject-form-actions material-delete-actions">
        <button ref={cancelRef} type="button" className="secondary-button" onClick={close}>
          {confirming ? 'Отмена' : 'Закрыть'}
        </button>

        {(confirming || retrying || state.pending) && (
          <button
            type="button"
            className="danger-button"
            disabled={busy || remaining > 0}
            onClick={() => { void actionRef.current?.remove(); }}
          >
            <Trash2 size={17} aria-hidden="true" />
            {state.pending ? 'Отправляем запрос…' : retrying ? 'Повторить удаление' : 'Удалить материал'}
          </button>
        )}

        {reviewing && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy || remaining > 0}
            onClick={() => { void actionRef.current?.review(); }}
          >
            <RefreshCw size={17} aria-hidden="true" />
            Проверить состояние
          </button>
        )}
      </div>
    </dialog>
  );
}
