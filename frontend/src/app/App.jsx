import { useEffect, useRef, useState } from 'react';
import { GraduationCap } from 'lucide-react';

import AuthPage from '../pages/AuthPage.jsx';
import DemoWorkspace from './DemoWorkspace.jsx';
import AccountWorkspace from './AccountWorkspace.jsx';
import { ApiError } from '../services/apiClient.js';
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
  const workspaceRef = useRef(null);

  // Один владелец запросов сессии. Старые ответы не меняют новый экран.
  const operationRef = useRef(null);
  const pendingIntentRef = useRef(null);

  function acceptSession(user) {
    const intent = pendingIntentRef.current;
    setAuthMessage(intent === 'logout'
      ? user ? LOGOUT_NOT_CONFIRMED : LOGGED_OUT
      : intent === 'login' && !user ? LOGIN_NOT_CONFIRMED : '');
    pendingIntentRef.current = null;
    setSession({ status: user ? 'authenticated' : 'guest', user });
  }

  useEffect(() => {
    const controller = new AbortController();
    operationRef.current?.abort();
    operationRef.current = controller;

    async function initializeSession() {
      try {
        const user = await sessionFlow.readSession({ signal: controller.signal });
        if (!controller.signal.aborted && operationRef.current === controller) {
          acceptSession(user);
        }
      } catch {
        if (!controller.signal.aborted && operationRef.current === controller) {
          setSession({ status: 'error', user: null });
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
        setSession({ status: 'error', user: null });
      } else {
        pendingIntentRef.current = null;
      }
      throw error;
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
    setAuthMessage('');
    // Убираем приватный экран сразу; его локальное состояние уничтожается.
    setSession({ status: 'signingOut', user: null });
    setScreen('login');

    try {
      const user = await sessionFlow.signOut({ signal: controller.signal });
      if (!controller.signal.aborted && operationRef.current === controller) {
        acceptSession(user);
      }
    } catch {
      if (!controller.signal.aborted && operationRef.current === controller) {
        setSession({ status: 'error', user: null });
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
    operationRef.current?.abort();
    setScreen('login');
    setSession({
      status: 'initializing',
      user: null,
    });

    setRetryAttempt((current) => current + 1);
  }

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
                Не удалось проверить сессию. Проверь подключение
                и доступность сервера, затем попробуй снова.
              </p>

              <button
                type="button"
                className="primary-button"
                onClick={retrySession}
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
