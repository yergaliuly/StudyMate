import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, RefreshCw, Sparkles, X } from 'lucide-react';
import {
  createMaterialSummaryController,
  getMaterialSummaryState,
} from '../../services/materialSummaryController.js';
import { getSummaryEditState } from '../../services/summaryEditAction.js';
import SummaryEditAction from './SummaryEditAction.jsx';
import '../../styles/materialSummary.css';

const statusLabels = {
  queued: 'Конспект в очереди',
  running: 'Создаём конспект',
  ready: 'Конспект готов',
  failed: 'Не удалось создать конспект',
  cancelled: 'Создание конспекта отменено',
};

const errorMessages = {
  AI_UNAVAILABLE: 'Сервис генерации сейчас недоступен.',
  AI_INVALID_RESPONSE: 'Не удалось получить корректный конспект. Результат не сохранён.',
  AI_OUTCOME_UNKNOWN: 'Результат обращения к ИИ неизвестен. Автоматического повтора не будет.',
  JOB_OUTCOME_UNKNOWN: 'Результат задания неизвестен. Автоматического повтора не будет.',
  JOB_TEMPORARY_FAILURE: 'При создании конспекта произошёл временный сбой.',
  JOB_PROCESSING_FAILED: 'Не удалось завершить создание конспекта.',
  JOB_ATTEMPTS_EXHAUSTED: 'Задание не смогло завершиться успешно.',
  JOB_LEASE_EXPIRED: 'Обработчик перестал отвечать. Обнови состояние конспекта.',
};

function GenerationConfirmation({ material, retry, regenerate, hasSaved, hasDraft, onClose, onConfirm }) {
  const id = useId();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const submittedRef = useRef(false);

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

  return (
    <dialog
      ref={dialogRef}
      className="subject-modal material-summary-confirm"
      aria-labelledby={id + '-heading'}
      aria-describedby={id + '-notice'}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="subject-modal-header">
        <span className="icon-tile"><Sparkles size={24} aria-hidden="true" /></span>
        <button type="button" className="icon-button" aria-label="Закрыть подтверждение" onClick={onClose}>
          <X size={21} aria-hidden="true" />
        </button>
      </div>
      <h2 id={id + '-heading'}>{retry ? 'Повторить запрос?'
        : regenerate ? 'Создать конспект заново?' : 'Создать конспект?'}</h2>
      <p className="material-summary-confirm-title">«{material.title}»</p>
      <div id={id + '-notice'} className="material-summary-notice">
        <p>
          Извлечённый текст этого PDF будет передан внешнему провайдеру OpenAI.
          Генерация расходует API-баланс и может содержать ошибки.
        </p>
        <p>Проверь важные тезисы и ссылки на страницы по исходному PDF.</p>
        {retry && <p>Повтор относится к прежнему запросу. Уже созданное задание не запускается заново.</p>}
        {retry && hasSaved && <p>
          При успешном завершении этой генерации текущий сохранённый конспект будет заменён,
          включая ручные правки. Перед повтором проверь показанную в панели версию.
        </p>}
        {regenerate && <p>
          Это новая генерация по тексту PDF. При успехе она заменит сохранённый конспект,
          включая ручные правки. До завершения и при ошибке прежняя версия останется доступной.
        </p>}
        {regenerate && hasDraft && <p>
          Несохранённый черновик останется в редакторе. После генерации его можно будет
          сравнить с новой версией; в генерации используется текст PDF.
        </p>}
      </div>
      <div className="subject-form-actions material-summary-confirm-actions">
        <button ref={cancelRef} type="button" className="secondary-button" onClick={onClose}>Отмена</button>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            if (submittedRef.current) return;
            submittedRef.current = true;
            onConfirm();
          }}
        >
          <Sparkles size={17} aria-hidden="true" />
          {retry ? 'Подтвердить повтор' : regenerate ? 'Подтвердить новую генерацию' : 'Подтвердить генерацию'}
        </button>
      </div>
    </dialog>
  );
}

export default function MaterialSummaryPanel({
  materialId,
  subjectId,
  record,
  canAct,
  onClose,
  onAccessError,
  onMaterialRead,
}) {
  const id = useId();
  const headingRef = useRef(null);
  const generateRef = useRef(null);
  const controllerRef = useRef(null);
  const callbacks = useRef({});
  callbacks.current = { canAct, onAccessError, onMaterialRead };

  const [state, setState] = useState(() => getMaterialSummaryState(record, materialId));
  const [editState, setEditState] = useState(() => getSummaryEditState(record, materialId));
  const [confirmation, setConfirmation] = useState(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    const controller = createMaterialSummaryController({
      record,
      materialId,
      subjectId,
      canAct: (value) => active && callbacks.current.canAct(value),
      canMutate: () => {
        const editor = getSummaryEditState(record, materialId);
        return !editor.open && !editor.pending && !editor.reading && !editor.gate;
      },
      onChange: (next) => {
        if (!active) return;
        setState(next);
        setNow(Date.now());
      },
      onAccessError: (error) => callbacks.current.onAccessError(error),
      onMaterialRead: (material) => callbacks.current.onMaterialRead?.(material),
    });
    controllerRef.current = controller;
    void controller.refresh();
    headingRef.current?.focus();

    return () => {
      active = false;
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
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

  if (!canAct(materialId)) return null;

  const busy = state.reading || state.pending;
  const remaining = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const summary = state.summary;
  const saved = summary?.version != null;
  const status = state.jobStatus === 'succeeded' ? summary?.status : state.jobStatus || summary?.status;
  const readyText = state.material?.status === 'stored' && state.material.processingStatus === 'ready';
  const canRequest = state.canGenerate || state.canRetry;
  const editBusy = editState.pending || editState.reading;
  const editBlocksGeneration = editState.open || editBusy || Boolean(editState.gate);
  const showRegenerate = Boolean(summary && state.material && !state.canRetry);

  function focusPanel() {
    window.requestAnimationFrame(() => {
      if (callbacks.current.canAct(materialId)) headingRef.current?.focus({ preventScroll: true });
    });
  }

  function closeConfirmation() {
    setConfirmation(null);
    window.requestAnimationFrame(() => {
      if (!callbacks.current.canAct(materialId)) return;
      if (generateRef.current?.isConnected) generateRef.current.focus({ preventScroll: true });
      else headingRef.current?.focus({ preventScroll: true });
    });
  }

  return (
    <section className="panel material-summary-panel" aria-labelledby={id + '-heading'}>
      <div className="material-summary-heading">
        <h3 ref={headingRef} id={id + '-heading'} tabIndex={-1}>Конспект материала</h3>
        <div className="material-summary-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy || editBusy || remaining > 0}
            onClick={() => { void controllerRef.current?.refresh(); }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Обновить конспект
          </button>
          <button type="button" className="secondary-button" onClick={onClose}>Закрыть конспект</button>
        </div>
      </div>

      {state.material && <p className="material-summary-title">{state.material.title}</p>}

      {busy && <p className="material-summary-hint" role="status">
        {state.pending ? 'Отправляем запрос…' : 'Проверяем состояние конспекта…'}
      </p>}

      {state.phase === 'unavailable' && <p role="status" className="material-summary-hint">
        Материал больше недоступен для конспекта. Обнови список материалов.
      </p>}

      {state.message && state.phase !== 'unavailable' && !state.watchError
        && state.message !== summary?.error?.message && (
        <p className="material-summary-hint" role="alert">{state.message}</p>
      )}

      {state.phase === 'ready' && state.empty && !saved && (
        <div className="material-summary-empty">
          <BookOpen size={26} aria-hidden="true" />
          <p>Конспект ещё не создан.</p>
          {!readyText && <p className="material-summary-hint">
            Сначала дождись извлечения текста PDF. Обработку можно открыть на карточке материала.
          </p>}
        </div>
      )}

      {status && statusLabels[status] && <p className="material-summary-status" role="status">
        {statusLabels[status]}
      </p>}

      {summary?.status === 'failed' && <p className="form-error" role="alert">
        {errorMessages[summary.error?.code] || 'Не удалось завершить создание конспекта.'}
      </p>}

      {state.watchError && <p className="material-summary-hint" role="alert">
        Проверка состояния остановлена. Нажми «Обновить конспект», чтобы продолжить.
      </p>}

      {state.watching && <p className="material-summary-hint">
        Состояние обновляется автоматически. Закрытие панели останавливает проверку,
        но не отменяет создание конспекта.
      </p>}

      {saved && (
        <div className="material-summary-saved">
          <div className="material-summary-meta">
            <h4>Сохранённый конспект</h4>
            <span>Версия {summary.version}</span>
            {summary.origin === 'user' && <span>Отредактирован вручную</span>}
            {summary.model === 'fake-local' && <span className="material-summary-demo">Демонстрационный конспект</span>}
          </div>
          {summary.status !== 'ready' && <p className="material-summary-hint">
            Показана последняя сохранённая версия.
          </p>}
          <pre className="material-summary-content">{summary.content}</pre>
          {summary.origin === 'ai' && <p className="material-summary-hint">
            Страницы-источники: {summary.sourcePages.join(', ')}.
            {' '}Ссылки на страницы не гарантируют точность тезисов — сверь важное с PDF.
          </p>}
        </div>
      )}

      {state.material?.status === 'stored' && (saved || editState.open || editState.content) && (
        <SummaryEditAction
          materialId={materialId}
          subjectId={subjectId}
          record={record}
          canAct={canAct}
          canWrite={() => getMaterialSummaryState(record, materialId).canEdit}
          writeEnabled={state.canEdit}
          onStateChange={setEditState}
          onRead={() => { void controllerRef.current?.refresh(); }}
          onSaved={() => {
            void controllerRef.current?.refresh();
            focusPanel();
          }}
          onAccessError={onAccessError}
        />
      )}

      {remaining > 0 && <p className="material-summary-hint" role="status">
        Повтор доступен через {remaining} сек.
      </p>}

      {(canRequest || showRegenerate) && state.material && (
        <div className="material-summary-generate">
          <p className="material-summary-hint">
            Конспект создаётся по извлечённому тексту PDF. Перед отправкой покажем подтверждение.
          </p>
          {editBlocksGeneration && <p className="material-summary-hint">
            {editState.gate
              ? 'Сначала проверь актуальный конспект в редакторе и выбери версию.'
              : 'Сохрани изменения или скрой редактор перед новой генерацией. Черновик сохранится.'}
          </p>}
          <button
            ref={generateRef}
            type="button"
            className="primary-button"
            disabled={busy || remaining > 0 || editBlocksGeneration
              || (!canRequest && !state.canRegenerate)}
            onClick={() => setConfirmation({
              retry: state.canRetry,
              regenerate: !canRequest,
              material: state.material,
              expected: summary ? { jobId: summary.jobId, version: summary.version } : null,
              hasSaved: saved,
              hasDraft: Boolean(editState.content && editState.content !== summary?.content),
            })}
          >
            <Sparkles size={17} aria-hidden="true" />
            {state.canRetry ? 'Повторить запрос' : showRegenerate ? 'Создать заново' : 'Создать конспект'}
          </button>
        </div>
      )}

      {confirmation && (
        <GenerationConfirmation
          material={confirmation.material}
          retry={confirmation.retry}
          regenerate={confirmation.regenerate}
          hasSaved={confirmation.hasSaved}
          hasDraft={confirmation.hasDraft}
          onClose={closeConfirmation}
          onConfirm={() => {
            setConfirmation(null);
            if (callbacks.current.canAct(materialId)) {
              if (confirmation.regenerate) void controllerRef.current?.regenerate(confirmation.expected);
              else void controllerRef.current?.generate(confirmation.expected);
            }
            focusPanel();
          }}
        />
      )}
    </section>
  );
}
