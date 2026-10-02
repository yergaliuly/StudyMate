import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { createMaterialDownloadAction } from '../../services/materialDownloadAction.js';

function startDownload(url) {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.rel = 'noreferrer';
  link.hidden = true;

  // Cross-origin PDF отдаётся сервером как attachment. Не загружаем его через fetch.
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

export default function MaterialDownloadAction({ material, canAct, onAccessError }) {
  const actionRef = useRef(null);
  const callbacks = useRef({});
  callbacks.current = { material, canAct, onAccessError };

  const [state, setState] = useState({ pending: false, retryAt: 0, message: '' });
  const [now, setNow] = useState(Date.now);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let active = true;
    setState({ pending: false, retryAt: 0, message: '' });
    setSent(false);

    const action = createMaterialDownloadAction({
      materialId: material.id,
      canAct: (id) => active && callbacks.current.canAct(id),
      getMaterial: () => callbacks.current.material,
      onChange: (next) => {
        if (!active) return;
        setState(next);
        setNow(Date.now());
      },
      onDownload: (url) => {
        startDownload(url);
        setSent(true);
      },
      onAccessError: (error) => callbacks.current.onAccessError(error),
    });

    actionRef.current = action;
    return () => {
      active = false;
      action.stop();
      if (actionRef.current === action) actionRef.current = null;
    };
  }, [material.id]);

  useEffect(() => {
    const timestamp = Date.now();
    setNow(timestamp);
    if (state.retryAt <= timestamp) return undefined;

    const timer = window.setInterval(() => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (timestamp >= state.retryAt) window.clearInterval(timer);
    }, 250);

    return () => window.clearInterval(timer);
  }, [state.retryAt]);

  if (!canAct(material.id) || material.status !== 'stored') return null;

  const remaining = Math.max(0, Math.ceil((state.retryAt - now) / 1000));

  return (
    <div
      className="material-text-state"
      role="group"
      aria-label="Скачивание оригинала"
      aria-busy={state.pending}
    >
      <button
        type="button"
        className="secondary-button"
        disabled={state.pending || remaining > 0}
        onClick={() => {
          setSent(false);
          void actionRef.current?.run();
        }}
      >
        <Download size={17} aria-hidden="true" />
        {state.pending ? 'Готовим скачивание…' : 'Скачать оригинал PDF'}
      </button>

      {state.message && <p className="form-error" role="alert">{state.message}</p>}

      {remaining > 0 && (
        <p className="material-text-hint" role="status">
          Повтор доступен через {remaining} сек.
        </p>
      )}

      {sent && (
        <p className="material-text-hint" role="status">
          Ссылка передана браузеру. Если загрузка не началась, попробуй снова.
        </p>
      )}
    </div>
  );
}
