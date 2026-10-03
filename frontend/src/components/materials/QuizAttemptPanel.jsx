import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, CircleMinus, Play, RefreshCw, Send, X, XCircle } from 'lucide-react';
import { createQuizAttemptController, getQuizAttemptState } from '../../services/quizAttemptController.js';
import '../../styles/quizAttempt.css';

const sameId = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const dateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

function SubmitConfirmation({ answers, retry, onClose, onConfirm }) {
  const id = useId();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const submittedRef = useRef(false);
  const answered = answers.filter((answer) => answer.optionId !== null).length;

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

  return <dialog ref={dialogRef} className="subject-modal quiz-attempt-confirm"
    aria-labelledby={id + '-title'} aria-describedby={id + '-notice'}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="subject-modal-header">
      <span className="icon-tile"><Send size={24} aria-hidden="true" /></span>
      <button type="button" className="icon-button" aria-label="Закрыть подтверждение отправки" onClick={onClose}>
        <X size={21} aria-hidden="true" />
      </button>
    </div>
    <h2 id={id + '-title'}>Отправить ответы?</h2>
    <div id={id + '-notice'} className="quiz-attempt-notice">
      <p>Отвечено: {answered} из {answers.length}. Пропущено: {answers.length - answered}.</p>
      <p>За пропущенные вопросы начисляется 0 баллов. После отправки изменить ответы в этой попытке нельзя.</p>
      {answered === 0 && <p>Все вопросы пропущены. Попытка завершится с результатом 0%.</p>}
      {retry && <p>Повторно отправится тот же набор ответов. Новая попытка не создаётся.</p>}
    </div>
    <div className="subject-form-actions quiz-attempt-confirm-actions">
      <button ref={cancelRef} type="button" className="secondary-button" onClick={onClose}>Вернуться к вопросам</button>
      <button type="button" className="primary-button" onClick={() => {
        if (submittedRef.current) return;
        submittedRef.current = true;
        onConfirm();
      }}><Send size={17} aria-hidden="true" />Подтвердить отправку</button>
    </div>
  </dialog>;
}

function AttemptReview({ attempt }) {
  return <ol className="material-quiz-questions" aria-label="Разбор ответов">
    {attempt.questions.map((question, index) => {
      const review = attempt.review[index];
      const kind = review.selectedOptionId === null ? 'skipped' : review.isCorrect ? 'correct' : 'incorrect';
      const StatusIcon = kind === 'correct' ? CheckCircle2 : kind === 'incorrect' ? XCircle : CircleMinus;
      return <li key={question.id} className="material-quiz-question quiz-attempt-review-question">
        <div className={'quiz-attempt-verdict verdict-' + kind}>
          <StatusIcon size={18} aria-hidden="true" />
          {kind === 'correct' ? 'Верно' : kind === 'incorrect' ? 'Неверно' : 'Пропущено'}
        </div>
        <h5><span>Вопрос {question.position}</span>{question.text}</h5>
        <ol className="material-quiz-options" aria-label={'Разбор вариантов вопроса ' + question.position}>
          {question.options.map((option) => {
            const correct = sameId(review.correctOptionId, option.id);
            const selected = sameId(review.selectedOptionId, option.id);
            return <li key={option.id} className={correct ? 'quiz-attempt-correct' : selected ? 'quiz-attempt-incorrect' : undefined}>
              <span className="material-quiz-option-marker" aria-hidden="true">{['А', 'Б', 'В', 'Г'][option.position - 1]}</span>
              <div className="quiz-attempt-review-option">
                <span>{option.text}</span>
                {(correct || selected) && <span className="quiz-attempt-answer-label">
                  {selected && <span>Твой ответ</span>}
                  {correct && <span>Правильный ответ</span>}
                </span>}
              </div>
            </li>;
          })}
        </ol>
        <div className="quiz-attempt-explanation">
          <h6>Объяснение</h6>
          <p>{review.explanation}</p>
          <p className="material-quiz-hint">Страницы PDF: {review.sourcePages.join(', ')}.</p>
        </div>
      </li>;
    })}
  </ol>;
}

export default function QuizAttemptPanel({ quiz, materialId, subjectId, record, canAct, onAccessError, children }) {
  const id = useId();
  const controllerRef = useRef(null);
  const headingRef = useRef(null);
  const submitRef = useRef(null);
  const focusStamp = useRef(null);
  const callbacks = useRef({});
  callbacks.current = { canAct, onAccessError };
  const [state, setState] = useState(() => getQuizAttemptState(record, quiz.id));
  const [confirmation, setConfirmation] = useState(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    const controller = createQuizAttemptController({
      record, quiz, materialId, subjectId,
      canAct: () => active && callbacks.current.canAct(),
      onAccessError: (error) => callbacks.current.onAccessError(error),
      onChange: (next) => { if (active) { setState(next); setNow(Date.now()); } },
    });
    controllerRef.current = controller;
    void controller.refresh();
    return () => {
      active = false;
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // The quiz is immutable; parent snapshots may change during generation polling.
  }, [record, quiz.id, materialId, subjectId]);

  useEffect(() => {
    setNow(Date.now());
    if (!state.retryAt || state.retryAt <= Date.now()) return undefined;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= state.retryAt) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [state.retryAt]);

  useEffect(() => {
    if (!state.attempt || !callbacks.current.canAct()) return;
    const stamp = state.attempt.id + ':' + state.attempt.status;
    if (focusStamp.current === stamp) return;
    focusStamp.current = stamp;
    headingRef.current?.focus();
  }, [state.attempt]);

  useEffect(() => {
    if (!state.attemptId || state.phase === 'completed' || state.phase === 'unavailable') return undefined;
    const beforeUnload = (event) => {
      if (!callbacks.current.canAct()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [state.attemptId, state.phase]);

  if (!canAct()) return null;
  const busy = state.pending || state.reading;
  const remaining = Math.max(0, Math.ceil(((state.retryAt || 0) - now) / 1000));
  const answers = state.answers || [];
  const answered = answers.filter((answer) => answer.optionId !== null).length;
  const attempt = state.attempt;
  const completed = attempt?.status === 'completed';
  const inProgress = attempt?.status === 'in_progress';
  const showStart = state.phase !== 'unavailable' && (!state.attemptId || completed);
  const showSubmit = state.phase !== 'unavailable' && (inProgress || state.canRetrySubmit);

  function openConfirmation() {
    setConfirmation({ answers: answers.map((answer) => ({ ...answer })), retry: state.submitUncertain || state.frozen });
  }

  function closeConfirmation() {
    setConfirmation(null);
    window.requestAnimationFrame(() => {
      if (!callbacks.current.canAct()) return;
      if (submitRef.current?.isConnected && !submitRef.current.disabled) submitRef.current.focus({ preventScroll: true });
      else headingRef.current?.focus({ preventScroll: true });
    });
  }

  const sendButton = showSubmit && <button ref={submitRef} type="button" className="primary-button"
    disabled={busy || remaining > 0 || !(state.canSubmit || state.canRetrySubmit)} onClick={openConfirmation}>
    <Send size={17} aria-hidden="true" />{state.submitUncertain || state.frozen ? 'Повторить отправку' : 'Отправить ответы'}
  </button>;

  return <div className="quiz-attempt-panel">
    <div className="quiz-attempt-toolbar">
      {showStart && <button type="button" className="primary-button"
        disabled={busy || remaining > 0 || !(state.canStart || state.canRetryStart)}
        onClick={() => { void controllerRef.current?.start(); }}>
        <Play size={17} aria-hidden="true" />
        {state.canRetryStart || state.startUncertain ? 'Повторить начало' : completed ? 'Пройти ещё раз' : 'Начать тест'}
      </button>}
      {state.attemptId && state.phase !== 'unavailable' && <button type="button" className="secondary-button"
        disabled={busy || remaining > 0 || !state.canRefresh}
        onClick={() => { void controllerRef.current?.refresh(); }}>
        <RefreshCw size={16} aria-hidden="true" />{state.submitUncertain || state.frozen ? 'Проверить результат' : 'Обновить попытку'}
      </button>}
    </div>
    {busy && <p className="material-quiz-hint" role="status">{state.reading ? 'Проверяем попытку…' : 'Отправляем запрос…'}</p>}
    {state.message && <p className="material-quiz-hint" role="alert">{state.message}</p>}
    {remaining > 0 && <p className="material-quiz-hint" role="status">Повтор доступен через {remaining} сек.</p>}
    {!state.attemptId && !busy && state.phase !== 'unavailable' && <>
      <p className="material-quiz-hint">Начни попытку, чтобы выбрать ответы. Можно пропускать вопросы; ограничения по времени нет.</p>
      {children}
    </>}

    {inProgress && <section className="quiz-attempt-content" aria-labelledby={id + '-questions'}>
      <div className="material-quiz-heading">
        <h4 ref={headingRef} id={id + '-questions'} tabIndex={-1}>Прохождение теста</h4>
        <p className="quiz-attempt-progress" role="status">Отвечено: {answered} из {attempt.questionCount}</p>
      </div>
      <p className="material-quiz-hint">Выбери один вариант в каждом вопросе. Выбор хранится в этой вкладке до перезагрузки или выхода из аккаунта. Закрытие панели сохранит его.</p>
      {(state.submitUncertain || state.frozen) && <p className="quiz-attempt-warning" role="status">
        Результат отправки ещё не подтверждён. Ответы зафиксированы: проверь результат или повтори отправку того же набора.
      </p>}
      <div className="quiz-attempt-questions">
        {attempt.questions.map((question) => {
          const selected = answers.find((answer) => sameId(answer.questionId, question.id))?.optionId;
          return <fieldset key={question.id} className="quiz-attempt-question" disabled={!state.canChoose || busy}>
            <legend>Вопрос {question.position}. {question.text}</legend>
            <div className="quiz-attempt-options">
              {question.options.map((option) => <label key={option.id}
                className={'quiz-attempt-option' + (sameId(selected, option.id) ? ' is-selected' : '')}>
                <input type="radio" name={id + '-' + question.id} value={option.id}
                  checked={sameId(selected, option.id)} onChange={() => controllerRef.current?.choose(question.id, option.id)} />
                <span>{option.text}</span>
              </label>)}
            </div>
            <button type="button" className="secondary-button quiz-attempt-clear" disabled={!selected}
              onClick={() => controllerRef.current?.choose(question.id, null)}>Сбросить ответ</button>
          </fieldset>;
        })}
      </div>
      <div className="quiz-attempt-toolbar">{sendButton}</div>
    </section>}
    {!inProgress && showSubmit && <div className="quiz-attempt-toolbar">{sendButton}</div>}

    {completed && <section className="quiz-attempt-content" aria-labelledby={id + '-result'}>
      <div className="material-quiz-heading">
        <h4 ref={headingRef} id={id + '-result'} tabIndex={-1}>Результат теста</h4>
        <span className="quiz-attempt-version">Версия {attempt.quizVersion}</span>
      </div>
      <div className="quiz-attempt-score">
        <strong>{attempt.scorePercent}%</strong>
        <div>
          <p>Правильных ответов: {attempt.correctCount} из {attempt.questionCount}</p>
          <p className="material-quiz-hint">Завершено: <time dateTime={attempt.completedAt}>{dateFormatter.format(new Date(attempt.completedAt))}</time></p>
        </div>
      </div>
      <p className="material-quiz-hint">Результат сохранён на сервере. Объяснения подготовлены ИИ при создании теста — сверь важные факты с указанными страницами PDF.</p>
      <AttemptReview attempt={attempt} />
    </section>}

    {confirmation && <SubmitConfirmation answers={confirmation.answers} retry={confirmation.retry}
      onClose={closeConfirmation} onConfirm={() => {
        setConfirmation(null);
        if (callbacks.current.canAct()) void controllerRef.current?.submit(confirmation.answers);
      }} />}
  </div>;
}
