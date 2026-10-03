import { useEffect, useId, useRef, useState } from 'react';
import { ClipboardList, Eye, RefreshCw, Sparkles, X } from 'lucide-react';
import {
  createMaterialQuizController,
  getMaterialQuizState,
} from '../../services/materialQuizController.js';
import '../../styles/materialQuiz.css';

const statusLabels = {
  queued: 'Тест в очереди',
  running: 'Создаём тест',
  ready: 'Тест готов',
  succeeded: 'Тест готов',
  failed: 'Не удалось создать тест',
  cancelled: 'Создание теста отменено',
  checking: 'Проверяем результат задания',
  unknown: 'Результат запуска неизвестен',
};

const errorMessages = {
  QUIZ_INSUFFICIENT_CONTENT: 'В PDF недостаточно материала для 10 вопросов. Выбери более содержательный материал.',
  AI_UNAVAILABLE: 'Сервис генерации сейчас недоступен.',
  AI_INVALID_RESPONSE: 'Не удалось получить корректный тест. Новая версия не сохранена.',
  AI_OUTCOME_UNKNOWN: 'Результат обращения к ИИ неизвестен. Автоматического повтора не будет.',
  JOB_OUTCOME_UNKNOWN: 'Результат задания неизвестен. Автоматического повтора не будет.',
  JOB_TEMPORARY_FAILURE: 'При создании теста произошёл временный сбой.',
  JOB_PROCESSING_FAILED: 'Не удалось завершить создание теста.',
  JOB_ATTEMPTS_EXHAUSTED: 'Задание не смогло завершиться успешно.',
  JOB_LEASE_EXPIRED: 'Обработчик перестал отвечать. Обнови состояние тестов.',
};

const dateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

function QuizGenerationConfirmation({ material, retry, newVersion, onClose, onConfirm }) {
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
      className="subject-modal material-quiz-confirm"
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
        : newVersion ? 'Создать новую версию теста?' : 'Создать тест?'}</h2>
      <p className="material-quiz-confirm-title">«{material.title}»</p>
      <div id={id + '-notice'} className="material-quiz-notice">
        <p>
          Извлечённый текст этого PDF будет передан внешнему провайдеру OpenAI.
          Генерация расходует API-баланс. Вопросы и варианты ответа могут содержать ошибки.
        </p>
        <p>Будет создано 10 вопросов по 4 варианта ответа. Тест строится по PDF, независимо от правок конспекта.</p>
        <p>Прежние версии теста и результаты попыток сохранятся.</p>
        {retry && <p>Повтор относится к прежнему запросу. Уже созданное задание не запускается заново.</p>}
      </div>
      <div className="subject-form-actions material-quiz-confirm-actions">
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
          {retry ? 'Подтвердить повтор' : newVersion ? 'Подтвердить новую генерацию' : 'Подтвердить генерацию'}
        </button>
      </div>
    </dialog>
  );
}

function QuizMeta({ quiz }) {
  return (
    <div className="material-quiz-meta">
      <span>{quiz.questionCount} вопросов</span>
      <time dateTime={quiz.createdAt}>{dateFormatter.format(new Date(quiz.createdAt))}</time>
      {quiz.model === 'fake-local' && <span className="material-quiz-demo">Демонстрационный тест</span>}
    </div>
  );
}

export default function MaterialQuizPanel({
  materialId, subjectId, record, canAct, onClose, onAccessError, onMaterialRead,
}) {
  const id = useId();
  const headingRef = useRef(null);
  const detailHeadingRef = useRef(null);
  const focusedQuizRef = useRef(null);
  const generateRef = useRef(null);
  const versionButtonsRef = useRef(new Map());
  const controllerRef = useRef(null);
  const callbacks = useRef({});
  callbacks.current = { canAct, onAccessError, onMaterialRead };
  const [state, setState] = useState(() => getMaterialQuizState(record, materialId));
  const [confirmation, setConfirmation] = useState(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    const controller = createMaterialQuizController({
      record, materialId, subjectId,
      canAct: (value) => active && callbacks.current.canAct(value),
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
    const until = Math.max(state.retryAt || 0, state.quizRetryAt || 0);
    setNow(Date.now());
    if (until <= Date.now()) return undefined;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= until) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [state.retryAt, state.quizRetryAt]);

  useEffect(() => {
    if (!state.selectedQuizId) focusedQuizRef.current = null;
    if (state.quizStatus !== 'ready' || !state.quiz
      || focusedQuizRef.current === state.quiz.id || !callbacks.current.canAct(materialId)) return;
    focusedQuizRef.current = state.quiz.id;
    detailHeadingRef.current?.focus();
  }, [state.selectedQuizId, state.quizStatus, state.quiz, materialId]);

  if (!canAct(materialId)) return null;

  const busy = state.pending || state.reading;
  const remaining = Math.max(0, Math.ceil(((state.retryAt || 0) - now) / 1000));
  const detailRemaining = Math.max(0, Math.ceil(((state.quizRetryAt || 0) - now) / 1000));
  const generation = state.generation;
  const checkingResult = (state.watching && !['queued', 'running'].includes(state.jobStatus))
    || (state.reading && state.jobStatus === 'succeeded');
  const status = state.watchError ? null
    : state.uncertain ? 'unknown'
      : checkingResult ? 'checking' : state.jobStatus || generation?.status;
  const readyText = state.material?.processingStatus === 'ready';
  const newVersion = (state.meta?.total ?? 0) > 0 || (generation && generation.status !== 'not_started');
  const totalPages = state.meta ? Math.max(1, Math.ceil(state.meta.total / state.meta.pageSize)) : 1;
  const quiz = state.quiz;

  function closeConfirmation() {
    setConfirmation(null);
    window.requestAnimationFrame(() => {
      if (!callbacks.current.canAct(materialId)) return;
      if (generateRef.current?.isConnected && !generateRef.current.disabled) generateRef.current.focus({ preventScroll: true });
      else headingRef.current?.focus({ preventScroll: true });
    });
  }

  function closeQuiz() {
    const quizId = state.selectedQuizId;
    controllerRef.current?.closeQuiz();
    window.requestAnimationFrame(() => {
      if (!callbacks.current.canAct(materialId)) return;
      const button = versionButtonsRef.current.get(quizId);
      if (button?.isConnected) button.focus({ preventScroll: true });
      else headingRef.current?.focus({ preventScroll: true });
    });
  }

  return (
    <section className="panel material-quiz-panel" aria-labelledby={id + '-heading'}>
      <div className="material-quiz-heading">
        <h3 ref={headingRef} id={id + '-heading'} tabIndex={-1}>Тесты материала</h3>
        <div className="material-quiz-actions">
          <button type="button" className="secondary-button" disabled={busy || remaining > 0}
            onClick={() => { void controllerRef.current?.refresh(); }}>
            <RefreshCw size={16} aria-hidden="true" />Обновить тесты
          </button>
          <button type="button" className="secondary-button" onClick={onClose}>Закрыть тесты</button>
        </div>
      </div>
      {state.material && <p className="material-quiz-title">{state.material.title}</p>}
      {busy && <p className="material-quiz-hint" role="status">
        {state.pending ? 'Отправляем запрос…' : 'Проверяем состояние тестов…'}
      </p>}
      {state.phase === 'unavailable' && <p className="material-quiz-hint" role="status">
        Материал больше недоступен для тестов. Обнови список материалов.
      </p>}
      {state.message && state.phase !== 'unavailable' && !state.watchError
        && state.message !== generation?.error?.message && <p className="material-quiz-hint" role="alert">{state.message}</p>}
      {statusLabels[status] && <p className="material-quiz-status" role="status">{statusLabels[status]}</p>}
      {generation?.status === 'failed' && <p className="form-error" role="alert">
        {errorMessages[generation.error?.code] || 'Не удалось завершить создание теста.'}
      </p>}
      {state.watchError && <p className="material-quiz-hint" role="alert">
        Проверка состояния остановлена. Нажми «Обновить тесты», чтобы продолжить.
      </p>}
      {state.watching && <p className="material-quiz-hint">
        Состояние обновляется автоматически. Закрытие панели остановит проверку, но создание теста продолжится на сервере.
      </p>}

      {state.material && state.phase !== 'unavailable' && <div className="material-quiz-generate">
        <p className="material-quiz-hint">10 вопросов по тексту PDF. Новая генерация сохранит прежние версии теста.</p>
        {!readyText && <p className="material-quiz-hint">Сначала дождись извлечения текста PDF. Обработку можно открыть на карточке материала.</p>}
        <button
          ref={generateRef}
          type="button"
          className="primary-button"
          disabled={busy || remaining > 0 || (!state.canGenerate && !state.canRetry)}
          onClick={() => setConfirmation({
            material: state.material, retry: state.canRetry, newVersion,
            expected: generation ? { jobId: generation.jobId, status: generation.status } : null,
          })}
        >
          <Sparkles size={17} aria-hidden="true" />
          {state.canRetry ? 'Повторить запрос' : newVersion ? 'Создать новую версию' : 'Создать тест'}
        </button>
      </div>}
      {remaining > 0 && <p className="material-quiz-hint" role="status">Повтор доступен через {remaining} сек.</p>}

      {state.meta && state.phase !== 'unavailable' && (generation || state.quizzes.length > 0) && <section className="material-quiz-versions" aria-labelledby={id + '-versions'}>
        <h4 id={id + '-versions'}>Версии теста</h4>
        {state.listStale && <p className="material-quiz-hint" role="status">
          Показан ранее загруженный список. Обнови тесты, чтобы проверить актуальные версии.
        </p>}
        {state.quizzes.length === 0 && !state.listStale && !busy && <div className="material-quiz-empty">
          <ClipboardList size={26} aria-hidden="true" />
          <p>{state.meta.total === 0 ? 'Сохранённых версий пока нет.' : 'На этой странице нет версий теста.'}</p>
        </div>}
        {state.quizzes.length > 0 && <ul className="material-quiz-version-list">
          {state.quizzes.map((version) => <li key={version.id} className="material-quiz-version">
            <div>
              <h5>Версия {version.version}</h5>
              <QuizMeta quiz={version} />
            </div>
            <button
              ref={(button) => {
                if (button) versionButtonsRef.current.set(version.id, button);
                else versionButtonsRef.current.delete(version.id);
              }}
              type="button"
              className="secondary-button"
              aria-expanded={state.selectedQuizId === version.id}
              aria-label={'Просмотреть версию ' + version.version}
              disabled={detailRemaining > 0}
              onClick={() => { void controllerRef.current?.openQuiz(version.id); }}
            ><Eye size={16} aria-hidden="true" />Просмотреть</button>
          </li>)}
        </ul>}
        {state.meta.total > 0 && <nav className="material-quiz-pagination" aria-label="Страницы версий теста">
          <p className="material-quiz-hint">Всего: {state.meta.total}. Страница {state.meta.page} из {totalPages}</p>
          <div className="material-quiz-actions">
            <button type="button" className="secondary-button"
              disabled={busy || remaining > 0 || state.meta.page <= 1}
              onClick={() => { void controllerRef.current?.changePage(state.meta.page - 1); }}>Предыдущие версии</button>
            <button type="button" className="secondary-button"
              disabled={busy || remaining > 0 || state.meta.page >= totalPages}
              onClick={() => { void controllerRef.current?.changePage(state.meta.page + 1); }}>Следующие версии</button>
          </div>
        </nav>}
      </section>}

      {state.material?.status === 'stored' && state.generatedQuizId && state.generatedQuizId !== state.selectedQuizId && <div className="material-quiz-result">
        <p className="material-quiz-hint">Новая версия теста создана. Текущий просмотр сохранён.</p>
        <button type="button" className="secondary-button" disabled={detailRemaining > 0}
          onClick={() => { void controllerRef.current?.openQuiz(state.generatedQuizId); }}>Открыть созданную версию</button>
      </div>}

      {state.material?.status === 'stored' && state.selectedQuizId && <section className="material-quiz-preview" aria-label="Просмотр теста" aria-busy={state.quizStatus === 'loading'}>
        <div className="material-quiz-heading">
          <h4 ref={detailHeadingRef} tabIndex={-1}>{quiz ? 'Версия ' + quiz.version : 'Просмотр теста'}</h4>
          <button type="button" className="secondary-button" onClick={closeQuiz}>Закрыть просмотр</button>
        </div>
        {state.quizStatus === 'loading' && <p className="material-quiz-hint" role="status">Загружаем вопросы…</p>}
        {state.quizMessage && <p className="material-quiz-hint" role="alert">{state.quizMessage}</p>}
        {(state.quizStatus === 'error' || state.quizStatus === 'unavailable') && <button
          type="button" className="secondary-button" disabled={detailRemaining > 0}
          onClick={() => { void controllerRef.current?.openQuiz(state.selectedQuizId); }}>Повторить загрузку теста</button>}
        {detailRemaining > 0 && <p className="material-quiz-hint" role="status">Загрузка теста доступна через {detailRemaining} сек.</p>}
        {quiz && <>
          <QuizMeta quiz={quiz} />
          <p className="material-quiz-hint">В каждом вопросе 4 варианта ответа. Вопросы подготовлены ИИ — сверь важные факты с материалом.</p>
          <ol className="material-quiz-questions" aria-label="Вопросы теста">
            {quiz.questions.map((question) => <li key={question.id} className="material-quiz-question">
              <h5><span>Вопрос {question.position}</span>{question.text}</h5>
              <ol className="material-quiz-options" aria-label={'Варианты ответа на вопрос ' + question.position}>
                {question.options.map((option) => <li key={option.id}>
                  <span className="material-quiz-option-marker" aria-hidden="true">{['А', 'Б', 'В', 'Г'][option.position - 1]}</span>
                  <span>{option.text}</span>
                </li>)}
              </ol>
            </li>)}
          </ol>
        </>}
      </section>}

      {confirmation && <QuizGenerationConfirmation
        material={confirmation.material}
        retry={confirmation.retry}
        newVersion={confirmation.newVersion}
        onClose={closeConfirmation}
        onConfirm={() => {
          setConfirmation(null);
          if (callbacks.current.canAct(materialId)) void controllerRef.current?.generate(confirmation.expected);
          window.requestAnimationFrame(() => {
            if (callbacks.current.canAct(materialId)) headingRef.current?.focus({ preventScroll: true });
          });
        }}
      />}
    </section>
  );
}
