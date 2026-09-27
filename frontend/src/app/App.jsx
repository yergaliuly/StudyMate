import { useEffect, useRef, useState } from 'react';

import AuthPage from '../pages/AuthPage.jsx';
import DemoWorkspace from './DemoWorkspace.jsx';

import '../styles/auth.css';

export default function App() {
  const [screen, setScreen] = useState('login');
  const [demoOpened, setDemoOpened] = useState(false);

  const workspaceRef = useRef(null);

  useEffect(() => {
    window.scrollTo(0, 0);

    if (screen === 'demo') {
      workspaceRef.current
        ?.querySelector('#main-content')
        ?.focus({ preventScroll: true });
    }
  }, [screen]);

  function openDemo() {
    setDemoOpened(true);
    setScreen('demo');
  }

  return (
    <>
      {screen !== 'demo' && (
        <AuthPage
          key={screen}
          mode={screen}
          onModeChange={setScreen}
          onOpenDemo={openDemo}
        />
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