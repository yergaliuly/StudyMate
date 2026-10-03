import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, ClipboardList, Clock3, RefreshCw, X } from 'lucide-react';
import { createAttemptHistoryController, getAttemptHistoryState } from '../../services/attemptHistoryController.js';
import QuizAttemptPanel from '../materials/QuizAttemptPanel.jsx';
import '../../styles/materialQuiz.css';
import '../../styles/attemptHistory.css';

const sameId = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const dateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

export default function AccountResults({ stateRef, attemptRecord, onAccessError, onAccessRestored }) {
  const id = useId();
  const record = useRef(stateRef.current).current;
  const runtime = useRef({ mounted: false, blocked: false }).current;
  const callbacks = useRef({});
  callbacks.current = { onAccessError, onAccessRestored };
  const controllerRef = useRef(null);
  const headingRef = useRef(null);
  const detailHeadingRef = useRef(null);
  const buttonsRef = useRef(new Map());
  const [state, setState] = useState(() => getAttemptHistoryState(record));
  const [now, setNow] = useState(Date.now);
  const [notice, setNotice] = useState('');
  const canAct = useCallback(() => runtime.mounted && !runtime.blocked
    && stateRef.current === record && record.active, [runtime, stateRef, record]);

  useEffect(() => {
    runtime.mounted = true;
    runtime.blocked = false;
    const controller = createAttemptHistoryController({
      record, canAct,
      onChange: (next) => { if (canAct()) { setState(next); setNow(Date.now()); } },
      onAccessError: (error) => {
        runtime.blocked = true;
        callbacks.current.onAccessError(error);
      },
      onAccessRestored: () => callbacks.current.onAccessRestored?.(),
    });
    controllerRef.current = controller;
    void controller.refresh();
    return () => {
      runtime.mounted = false;
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [record, canAct, runtime]);

  useEffect(() => {
    const until = Math.max(state.retryAt || 0, state.detailRetryAt || 0);
    setNow(Date.now());
    if (until <= Date.now()) return undefined;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= until) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [state.retryAt, state.detailRetryAt]);

  useEffect(() => {
    if (state.selectedAttemptId && canAct()) detailHeadingRef.current?.focus();
  }, [state.selectedAttemptId, canAct]);

  const remaining = Math.max(0, Math.ceil(((state.retryAt || 0) - now) / 1000));
  const detailRemaining = Math.max(0, Math.ceil(((state.detailRetryAt || 0) - now) / 1000));
  const filters = state.filters;
  const filtered = Boolean(filters.status || filters.materialId || filters.quizId);
  const totalPages = Math.max(1, Math.ceil(state.meta.total / state.meta.pageSize));
  const detail = state.detail;
  const contextMaterial = state.attempts.find((row) => sameId(row.materialId, filters.materialId) && row.materialStatus === 'ready');
  const materialTitle = contextMaterial?.materialTitle || record.filterContext?.materialTitle;

  function changeFilters(next, context, focusHeading = false) {
    if (!canAct()) return;
    // Row filters and reset remove their own buttons; the select keeps its focus.
    if (focusHeading) headingRef.current?.focus();
    if (context) record.filterContext = context;
    if (!next.materialId && !next.quizId) record.filterContext = null;
    setNotice('');
    void controllerRef.current?.setFilters(next);
  }

  function closeAttempt() {
    const selectedId = state.selectedAttemptId;
    controllerRef.current?.closeAttempt();
    window.requestAnimationFrame(() => {
      if (!canAct()) return;
      const button = buttonsRef.current.get(selectedId);
      if (button?.isConnected) button.focus({ preventScroll: true });
      else headingRef.current?.focus({ preventScroll: true });
    });
  }

  function unavailableAttempt() {
    if (!canAct()) return;
    controllerRef.current?.closeAttempt();
    setNotice('Попытка больше недоступна. Обнови историю, если список не изменился.');
    void controllerRef.current?.refresh({ preserveDetail: true });
  }

  return <section className="attempt-history" aria-labelledby={id + '-heading'}>
    <div className="panel attempt-history-controls">
      <div className="attempt-history-heading">
        <h2 ref={headingRef} id={id + '-heading'} tabIndex={-1}>История попыток</h2>
        <button type="button" className="secondary-button"
          disabled={state.reading || state.namesLoading || remaining > 0}
          onClick={() => { setNotice(''); void controllerRef.current?.refresh(); }}>
          <RefreshCw size={16} aria-hidden="true" />Обновить историю
        </button>
      </div>
      <p className="material-quiz-hint">Открой сохранённый результат или продолжи незавершённую попытку. После перезагрузки вопросы восстановятся с сервера, а неотправленные ответы нужно выбрать заново.</p>
      <div className="attempt-history-filters">
        <label className="attempt-history-status-filter">
          <span>Статус попытки</span>
          <select value={filters.status || ''} onChange={(event) => changeFilters({ ...filters, status: event.target.value || undefined })}>
            <option value="">Все попытки</option>
            <option value="in_progress">Не завершены</option>
            <option value="completed">Завершены</option>
          </select>
        </label>
        {filtered && <button type="button" className="secondary-button" onClick={() => changeFilters({}, null, true)}>
          <X size={16} aria-hidden="true" />Сбросить фильтры
        </button>}
      </div>
      {(filters.materialId || filters.quizId) && <div className="attempt-history-context" role="status">
        {filters.materialId && <span>{materialTitle ? 'Материал: ' + materialTitle : 'Попытки выбранного материала'}</span>}
        {filters.quizId && <span>{record.filterContext?.quizVersion
          ? 'Версия ' + record.filterContext.quizVersion : 'Выбрана одна версия теста'}</span>}
      </div>}
      {remaining > 0 && <p className="material-quiz-hint" role="status">Обновление доступно через {remaining} сек.</p>}
    </div>

    {notice && <p className="panel attempt-history-message" role="status">{notice}</p>}
    {state.selectedAttemptId && <section className="panel material-quiz-panel attempt-history-detail" aria-label="Выбранная попытка">
      <div className="material-quiz-heading">
        <h3 ref={detailHeadingRef} tabIndex={-1}>{detail?.material.title || 'Попытка'}</h3>
        <button type="button" className="secondary-button" onClick={closeAttempt}>Закрыть попытку</button>
      </div>
      {state.detailPhase === 'loading' && <p className="material-quiz-hint" role="status">Открываем попытку…</p>}
      {state.detailMessage && <p className="material-quiz-hint" role="alert">{state.detailMessage}</p>}
      {(state.detailPhase === 'error' || state.detailPhase === 'unavailable') && <div className="attempt-history-actions">
        <button type="button" className="secondary-button" disabled={detailRemaining > 0}
          onClick={() => { void controllerRef.current?.openAttempt(state.selectedAttemptId); }}>Повторить открытие попытки</button>
      </div>}
      {detailRemaining > 0 && <p className="material-quiz-hint" role="status">Открытие доступно через {detailRemaining} сек.</p>}
      {state.detailPhase === 'ready' && detail && <>
        <p className="material-quiz-hint">Версия {detail.attempt.quizVersion}. Начало: <time dateTime={detail.attempt.startedAt}>{dateFormatter.format(new Date(detail.attempt.startedAt))}</time></p>
        <QuizAttemptPanel key={detail.attempt.id} quiz={detail.quiz}
          materialId={detail.material.id} subjectId={detail.material.subjectId}
          record={attemptRecord} existingAttemptId={detail.attempt.id}
          canAct={() => canAct() && sameId(record.attemptHistory.selectedAttemptId, detail.attempt.id)
            && record.attemptHistory.view.detailPhase === 'ready'}
          onAccessError={(error) => {
            runtime.blocked = true;
            callbacks.current.onAccessError(error);
          }}
          onCompleted={() => { void controllerRef.current?.refresh({ preserveDetail: true }); }}
          onUnavailable={unavailableAttempt}
        />
      </>}
    </section>}

    {state.message && <p className="panel attempt-history-message" role="alert">{state.message}</p>}
    {state.reading && <p className="panel attempt-history-message" role="status">Загружаем историю…</p>}
    {state.namesError && <p className="material-quiz-hint" role="status">Часть названий материалов не загрузилась. Обнови историю, чтобы проверить их.</p>}
    {state.listStale && state.attempts.length > 0 && <p className="material-quiz-hint" role="status">Показан ранее загруженный список. Обнови историю для проверки актуальных данных.</p>}
    {state.phase === 'ready' && state.attempts.length === 0 && <div className="panel attempt-history-empty">
      <ClipboardList size={30} aria-hidden="true" />
      <h3>{filtered ? 'Нет попыток по выбранным фильтрам' : 'Пока нет попыток'}</h3>
      <p>{filtered ? 'Измени фильтры или сбрось их.' : 'Открой тест в материалах предмета и начни прохождение.'}</p>
    </div>}
    {!state.reading && state.phase === 'loading' && !state.attempts.length && <p className="material-quiz-hint">Нажми «Обновить историю», чтобы загрузить список.</p>}
    {state.attempts.length > 0 && <ul className="attempt-history-list" aria-label="Попытки">
      {state.attempts.map((row) => <li key={row.id} className="panel attempt-history-card">
        <div className="attempt-history-heading">
          <h3>{row.materialTitle}</h3>
          <span className={'attempt-history-status status-' + row.status}>
            {row.status === 'completed' ? <CheckCircle2 size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}
            {row.status === 'completed' ? 'Завершена' : 'Не завершена'}
          </span>
        </div>
        <div className="attempt-history-meta">
          <span>Версия {row.quizVersion}</span>
          <span>Начало: <time dateTime={row.startedAt}>{dateFormatter.format(new Date(row.startedAt))}</time></span>
          {row.status === 'completed' && <span>Завершено: <time dateTime={row.completedAt}>{dateFormatter.format(new Date(row.completedAt))}</time></span>}
        </div>
        {row.status === 'completed'
          ? <p className="attempt-history-score">{row.scorePercent}% <span>Правильных ответов: {row.correctCount} из {row.questionCount}</span></p>
          : <p className="material-quiz-hint">Результат появится после отправки ответов.</p>}
        {row.materialStatus === 'loading' && <p className="material-quiz-hint">Загружаем название материала…</p>}
        {row.materialStatus === 'error' && <p className="material-quiz-hint">Название материала не загружено.</p>}
        {row.materialStatus === 'unavailable' && <p className="material-quiz-hint">Материал удалён или удаляется. Попытка недоступна.</p>}
        <div className="attempt-history-actions">
          <button ref={(button) => {
            if (button) buttonsRef.current.set(row.id, button);
            else buttonsRef.current.delete(row.id);
          }} type="button" className="primary-button" disabled={row.materialStatus === 'unavailable' || detailRemaining > 0}
            aria-expanded={sameId(state.selectedAttemptId, row.id)}
            onClick={() => { setNotice(''); void controllerRef.current?.openAttempt(row.id); }}>
            {row.status === 'completed' ? 'Открыть результат' : 'Продолжить'}
          </button>
          <button type="button" className="secondary-button" disabled={row.materialStatus === 'unavailable'}
            onClick={() => changeFilters({ status: filters.status, materialId: row.materialId }, { materialTitle: row.materialTitle }, true)}>Попытки материала</button>
          <button type="button" className="secondary-button" disabled={row.materialStatus === 'unavailable'}
            onClick={() => changeFilters({ status: filters.status, materialId: row.materialId, quizId: row.quizId }, { materialTitle: row.materialTitle, quizVersion: row.quizVersion }, true)}>Попытки этой версии</button>
        </div>
      </li>)}
    </ul>}
    {state.meta.total > 0 && <nav className="panel attempt-history-pagination" aria-label="Страницы истории">
      <p>Всего: {state.meta.total}. Страница {state.meta.page} из {totalPages}</p>
      <div className="attempt-history-actions">
        <button type="button" className="secondary-button" disabled={state.reading || remaining > 0 || state.meta.page <= 1}
          onClick={() => { void controllerRef.current?.changePage(state.meta.page - 1); }}>Предыдущие попытки</button>
        <button type="button" className="secondary-button" disabled={state.reading || remaining > 0 || state.meta.page >= totalPages}
          onClick={() => { void controllerRef.current?.changePage(state.meta.page + 1); }}>Следующие попытки</button>
      </div>
    </nav>}
  </section>;
}
