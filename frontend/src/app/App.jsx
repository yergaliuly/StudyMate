import { useCallback, useEffect, useRef, useState } from 'react';
import { GraduationCap } from 'lucide-react';

import AuthPage from '../pages/AuthPage.jsx';
import DemoWorkspace from './DemoWorkspace.jsx';
import AccountWorkspace from './AccountWorkspace.jsx';
import { ApiError } from '../services/apiClient.js';
import { isRateLimited } from '../services/retryAfter.js';
import { useRetryCooldown } from '../hooks/useRetryCooldown.js';
import {
  sessionFlow,
  LOGIN_NOT_CONFIRMED,
  LOGOUT_NOT_CONFIRMED,
  LOGGED_OUT,
} from '../services/sessionFlow.js';

import '../styles/auth.css';

function SessionPanel({ title, children }) {
  return (
    <main className="auth-page">
      <section
        className="panel auth-panel session-panel"
        aria-labelledby="session-title"
      >
        <div className="auth-brand">
          <GraduationCap size={33} aria-hidden="true" />

          <span>
            Study<span>Mate</span>
          </span>
        </div>

        <h1 id="session-title">{title}</h1>

        <div className="session-panel-content">
          {children}
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [screen, setScreen] = useState('login');
  const [demoOpened, setDemoOpened] = useState(false);
  const [authMessage, setAuthMessage] = useState('');

  const [session, setSession] = useState({
    status: 'initializing',
    user: null,
  });

  const [retryAttempt, setRetryAttempt] = useState(0);
  const cooldown = useRetryCooldown();
  const workspaceRef = useRef(null);

  // Один владелец запросов сессии. Старые ответы не меняют новый экран.
  const operationRef = useRef(null);
  const pendingIntentRef = useRef(null);
  // Черновик живёт только в памяти и возвращается только своему владельцу.
  const subjectDraftRef = useRef(null);
  const subjectListRef = useRef(null);
  const subjectDetailRef = useRef(null);
  const materialsRef = useRef(null);
  const resultsRef = useRef(null);
  const attemptsRef = useRef(null);
  const draftOwnerRef = useRef(null);
  const recoveringAccessRef = useRef(false);

  function acceptSession(user) {
    if (user && draftOwnerRef.current !== user.id) {
      subjectDraftRef.current = null;
      subjectListRef.current = null;
      subjectDetailRef.current = null;
      materialsRef.current = null;
      resultsRef.current = null;
      attemptsRef.current = null;
      draftOwnerRef.current = user.id;
      recoveringAccessRef.current = false;
    }
    const intent = pendingIntentRef.current;
    if (intent === 'login') recoveringAccessRef.current = false;
    setAuthMessage(intent === 'logout'
      ? user ? LOGOUT_NOT_CONFIRMED : LOGGED_OUT
      : intent === 'login' && !user ? LOGIN_NOT_CONFIRMED
        : intent === 'reauth' && !user ? 'Сессия истекла. Войди снова.' : '');
    pendingIntentRef.current = null;
    setSession({ status: user ? 'authenticated' : 'guest', user });
  }

  useEffect(() => {
    const controller = new AbortController();
    operationRef.current?.abort();
    operationRef.current = controller;

    async function initializeSession() {
      try {
        const read = pendingIntentRef.current === 'reauth'
          ? sessionFlow.recoverSession : sessionFlow.readSession;
        const user = await read({ signal: controller.signal });
        if (!controller.signal.aborted && operationRef.current === controller) {
          acceptSession(user);
        }
      } catch (error) {
        if (!controller.signal.aborted && operationRef.current === controller) {
          cooldown.remember(error);
          setSession({ status: 'error', user: null, rateLimited: isRateLimited(error) });
        }
      } finally {
        if (operationRef.current === controller) {
          operationRef.current = null;
        }
      }
    }

    void initializeSession();
    return () => {
      controller.abort();
      operationRef.current?.abort();
      operationRef.current = null;
    };
  }, [retryAttempt]);

  async function handleLogin(values, { signal }) {
    if (operationRef.current) {
      throw new ApiError('Дождись завершения запроса.');
    }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    operationRef.current = controller;
    pendingIntentRef.current = 'login';

    try {
      const user = await sessionFlow.signIn(values, { signal: controller.signal });
      if (controller.signal.aborted || operationRef.current !== controller) return;
      if (!user) {
        throw new ApiError(LOGIN_NOT_CONFIRMED, { code: 'LOGIN_NOT_CONFIRMED' });
      }
      acceptSession(user);
    } catch (error) {
      if (controller.signal.aborted || operationRef.current !== controller) return;
      if (error?.code === 'SESSION_CHECK_FAILED') {
        cooldown.remember(error);
        setSession({ status: 'error', user: null, rateLimited: isRateLimited(error) });
      } else {
        pendingIntentRef.current = null;
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (operationRef.current === controller) operationRef.current = null;
    }
  }

  async function handleRecoverCsrf({ signal }) {
    if (operationRef.current) throw new ApiError('Дождись завершения запроса.');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    operationRef.current = controller;
    try {
      const user = await sessionFlow.recoverSession({ signal: controller.signal });
      if (controller.signal.aborted || operationRef.current !== controller) return;
      // Гостевую форму не размонтируем: её введённые данные остаются в памяти.
      if (user) acceptSession(user);
    } finally {
      signal.removeEventListener('abort', cancel);
      if (operationRef.current === controller) operationRef.current = null;
    }
  }

  async function handleLogout() {
    if (operationRef.current) return;
    const controller = new AbortController();
    operationRef.current = controller;
    pendingIntentRef.current = 'logout';
    subjectDraftRef.current = null;
    subjectListRef.current = null;
    subjectDetailRef.current = null;
    materialsRef.current = null;
    resultsRef.current = null;
    attemptsRef.current = null;
    draftOwnerRef.current = null;
    recoveringAccessRef.current = false;
    setAuthMessage('');
    // Убираем приватный экран сразу; его локальное состояние уничтожается.
    setSession({ status: 'signingOut', user: null });
    setScreen('login');

    try {
      const user = await sessionFlow.signOut({ signal: controller.signal });
      if (!controller.signal.aborted && operationRef.current === controller) {
        acceptSession(user);
      }
    } catch (error) {
      if (!controller.signal.aborted && operationRef.current === controller) {
        cooldown.remember(error);
        setSession({ status: 'error', user: null, rateLimited: isRateLimited(error) });
      }
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
    }
  }

  useEffect(() => {
    window.scrollTo(0, 0);

    if (screen === 'demo') {
      workspaceRef.current
        ?.querySelector('#main-content')
        ?.focus({ preventScroll: true });
    }
  }, [screen]);

  function retrySession() {
    if (cooldown.isBlocked() || operationRef.current) return;
    recoveringAccessRef.current = false;
    operationRef.current?.abort();
    setScreen('login');
    setSession({
      status: 'initializing',
      user: null,
    });

    setRetryAttempt((current) => current + 1);
  }

  const handleAccountAccessError = useCallback(() => {
    // Не повторяем изменение после восстановления сессии: пользователь решит сам.
    if (operationRef.current) return;
    if (recoveringAccessRef.current) {
      setSession({ status: 'error', user: null });
      return;
    }
    recoveringAccessRef.current = true;
    pendingIntentRef.current = 'reauth';
    setScreen('login');
    setSession({ status: 'initializing', user: null });
    setRetryAttempt((current) => current + 1);
  }, []);

  const handleAccountAccessRestored = useCallback(() => {
    recoveringAccessRef.current = false;
  }, []);

  function changeAuthMode(mode) {
    setAuthMessage('');
    setScreen(mode);
  }

  function handleRegistered() {
    // Регистрация не создаёт сессию: остаёмся в состоянии guest.
    setAuthMessage('Аккаунт создан. Теперь войдите.');
    setScreen('login');
  }

  function openDemo() {
    setAuthMessage('');
    setDemoOpened(true);
    setScreen('demo');
  }

  return (
    <>
      {screen !== 'demo' && (
        <>
          {session.status === 'initializing' && (
            <SessionPanel title="Проверяем сессию…">
              <p className="auth-description" role="status">
                Подключаемся к StudyMate.
              </p>
            </SessionPanel>
          )}

          {session.status === 'signingOut' && (
            <SessionPanel title="Выходим из аккаунта…">
              <p className="auth-description" role="status">Проверяем завершение сессии.</p>
            </SessionPanel>
          )}

          {session.status === 'error' && (
            <SessionPanel title="Не удалось подключиться">
              <p className="auth-feedback" role="alert">
                {session.rateLimited
                  ? 'Слишком много запросов. Подожди перед повторной проверкой сессии.'
                  : 'Не удалось проверить сессию. Проверь подключение и доступность сервера, затем попробуй снова.'}
              </p>
              {cooldown.blocked && <p role="status">Повторная проверка через {cooldown.seconds} с.</p>}

              <button
                type="button"
                className="primary-button"
                onClick={retrySession}
                disabled={cooldown.blocked}
              >
                Повторить проверку
              </button>

              <button
                type="button"
                className="secondary-button"
                onClick={openDemo}
              >
                Открыть демо-кабинет
              </button>
            </SessionPanel>
          )}

          {session.status === 'guest' && (
            <AuthPage
              key={screen}
              mode={screen}
              initialMessage={authMessage}
              onRegistered={handleRegistered}
              onLogin={handleLogin}
              onRecoverCsrf={handleRecoverCsrf}
              cooldown={cooldown}
              onModeChange={changeAuthMode}
              onOpenDemo={openDemo}
            />
          )}

          {session.status === 'authenticated' && (
            <AccountWorkspace
              key={session.user.id}
              user={session.user}
              message={authMessage}
              onLogout={handleLogout}
              onOpenDemo={openDemo}
              draftRef={subjectDraftRef}
              listRef={subjectListRef}
              detailRef={subjectDetailRef}
              materialsRef={materialsRef}
              resultsRef={resultsRef}
              attemptsRef={attemptsRef}
              onAccessError={handleAccountAccessError}
              onAccessRestored={handleAccountAccessRestored}
            />
          )}
        </>
      )}

      {demoOpened && (
        <div
          ref={workspaceRef}
          hidden={screen !== 'demo'}
        >
          <DemoWorkspace
            onOpenAuth={() => changeAuthMode('login')}
            authActionLabel={session.status === 'authenticated'
              ? 'Вернуться в аккаунт'
              : 'Открыть форму входа'}
          />
        </div>
      )}
    </>
  );
}
