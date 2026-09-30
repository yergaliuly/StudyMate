import { useEffect, useRef, useState } from 'react';
import {
  canProcessMaterial,
  createMaterialProcessingAction,
  getMaterialProcessingState,
} from '../../services/materialProcessingAction.js';

export default function MaterialProcessAction({
  material,
  record,
  canAct,
  onRefresh,
  onAccessError,
}) {
  const actionRef = useRef(null);
  const callbacks = useRef({});

  callbacks.current = {
    material,
    canAct,
    onRefresh,
    onAccessError,
  };

  const [state, setState] = useState(
    () => getMaterialProcessingState(record, material.id),
  );
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;

    const action = createMaterialProcessingAction({
      record,
      materialId: material.id,
      canAct: (id) => active && callbacks.current.canAct(id),
      getMaterial: () => callbacks.current.material,
      onChange: (next) => {
        if (active) setState(next);
      },
      onRefresh: () => {
        if (active) callbacks.current.onRefresh();
      },
      onAccessError: (error) => {
        if (active) callbacks.current.onAccessError(error);
      },
    });

    actionRef.current = action;

    return () => {
      active = false;
      action.stop();

      if (actionRef.current === action) {
        actionRef.current = null;
      }
    };
  }, [record, material.id]);

  // Свежий GET мог подтвердить попытку,
  // пока компонент оставался открыт.
  useEffect(() => {
    setState(getMaterialProcessingState(record, material.id));
    setNow(Date.now());
  }, [record, material]);

  useEffect(() => {
    if (state.retryAt <= Date.now()) return undefined;

    const timer = window.setInterval(() => {
      const timestamp = Date.now();
      setNow(timestamp);

      if (timestamp >= state.retryAt) {
        window.clearInterval(timer);
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [state.retryAt]);

  if (!canAct(material.id)) return null;

  const available = canProcessMaterial(material);
  const remaining = Math.max(
    0,
    Math.ceil((state.retryAt - now) / 1000),
  );

  if (!available && !state.hasAttempt) {
    return material.processingStatus === 'failed' ? (
      <p className="material-text-hint">
        Повтор обработки этого файла не устранит причину ошибки.
        Подготовь другую копию PDF и загрузи её как новый материал.
      </p>
    ) : null;
  }

  const label = state.pending
    ? 'Отправляем запрос…'
    : state.awaitingRead
      ? 'Проверяем результат…'
      : state.hasAttempt
        ? 'Повторить запрос запуска'
        : material.processingStatus === 'not_started'
          ? 'Извлечь текст'
          : 'Повторить обработку';

  return (
    <div className="material-text-state" aria-busy={state.pending}>
      {state.message && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}

      {state.uncertain && (
        <p className="material-text-hint">
          Ответ не подтверждён, но обработка могла начаться.
          Нажми «Обновить материал», чтобы проверить состояние,
          или повтори прежний запрос запуска.
        </p>
      )}

      {remaining > 0 && (
        <p className="material-text-hint" role="status">
          Повтор доступен через {remaining} сек.
        </p>
      )}

      <button
        type="button"
        className="secondary-button"
        disabled={
          state.pending
          || state.awaitingRead
          || remaining > 0
        }
        onClick={() => {
          void actionRef.current?.run();
        }}
      >
        {label}
      </button>
    </div>
  );
}