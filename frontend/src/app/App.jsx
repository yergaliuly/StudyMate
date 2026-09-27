import { useEffect, useRef, useState } from 'react';
import { GraduationCap } from 'lucide-react';

import AuthPage from '../pages/AuthPage.jsx';
import DemoWorkspace from './DemoWorkspace.jsx';
import { authApi } from '../services/authApi.js';

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

  const [session, setSession] = useState({
    status: 'initializing',
    user: null,
  });

  const [retryAttempt, setRetryAttempt] = useState(0);
  const workspaceRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function initializeSession() {
      try {
        await authApi.refreshCsrf({ signal });

        if (signal.aborted) {
          return;
        }

        const user = await authApi.getCurrentUser({ signal });

        if (signal.aborted) {
          return;
        }

        setSession({
          status: user ? 'authenticated' : 'guest',
          user,
        });
      } catch {
        if (signal.aborted) {
          return;
        }

        setSession({
          status: 'error',
          user: null,
        });
      }
    }

    void initializeSession();

    return () => controller.abort();
  }, [retryAttempt]);

  useEffect(() => {
    window.scrollTo(0, 0);

    if (screen === 'demo') {
      workspaceRef.current
        ?.querySelector('#main-content')
        ?.focus({ preventScroll: true });
    }
  }, [screen]);

  function retrySession() {
    setSession({
      status: 'initializing',
      user: null,
    });

    setRetryAttempt((current) => current + 1);
  }

  function openDemo() {
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
              onModeChange={setScreen}
              onOpenDemo={openDemo}
            />
          )}

          {session.status === 'authenticated' && (
            <SessionPanel title={session.user.displayName}>
              <p className="auth-description">
                {session.user.email}
              </p>

              <p className="auth-feedback">
                Аккаунт подключён к серверу
              </p>

              <p className="auth-description">
                Предметы аккаунта будут подключены после
                backend этапа 5.
              </p>

              <button
                type="button"
                className="secondary-button"
                onClick={openDemo}
              >
                Открыть демо-кабинет
              </button>
            </SessionPanel>
          )}
        </>
      )}

      {demoOpened && (
        <div
          ref={workspaceRef}
          hidden={screen !== 'demo'}
        >
          <DemoWorkspace
            onOpenAuth={() => setScreen('login')}
          />
        </div>
      )}
    </>
  );
}