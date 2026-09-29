import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, LogOut, Sparkles } from 'lucide-react';

import Header from '../components/layout/Header.jsx';
import Sidebar from '../components/layout/Sidebar.jsx';
import AccountSubjects from '../components/subjects/AccountSubjects.jsx';
import '../styles/account.css';
import AccountMaterials from '../components/materials/AccountMaterials.jsx';

const pageTitles = {
  dashboard: 'Мой кабинет',
  subjects: 'Мои предметы',
  lectures: 'Лекции',
  flashcards: 'Карточки',
  results: 'Результаты',
  settings: 'Настройки',
};

function getInitials(displayName) {
  const segmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' });

  return displayName
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => segmenter.segment(part)[Symbol.iterator]().next().value?.segment ?? '')
    .join('')
    .toLocaleUpperCase('ru');
}

export default function AccountWorkspace({
  user,
  onLogout,
  onOpenDemo,
  message = '',
  draftRef,
  detailRef,
  materialsRef,
  onAccessError,
  onAccessRestored,
}) {
  const [materialSubjectId, setMaterialSubjectId] = useState(
  () => materialsRef.current?.selectedSubjectId ?? null,
);

  const [activePage, setActivePage] = useState(
  () => materialSubjectId ? 'subjects' : 'dashboard',
);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const headingRef = useRef(null);
  const initials = getInitials(user.displayName);
  const showSubjects = activePage === 'dashboard' || activePage === 'subjects';

  const closeMenu = useCallback(() => {
    setIsMenuOpen(false);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
}, [activePage, materialSubjectId]);

  function handleNavigate(page) {
  if (materialsRef.current) {
    materialsRef.current.selectedSubjectId = null;
  }

  setMaterialSubjectId(null);
  setActivePage(page);
  closeMenu();
}

function openMaterials(id) {
  const subjectId = id.toLowerCase();

  if (!materialsRef.current) {
    materialsRef.current = {
      selectedSubjectId: null,
      records: {},
    };
  }

  const scope = materialsRef.current;

  if (!scope.records[subjectId]) {
    scope.records[subjectId] = {
      search: '',
      q: '',
      page: 1,
    };
  }

  scope.selectedSubjectId = subjectId;
  detailRef.current = null;

  setMaterialSubjectId(subjectId);
  setActivePage('subjects');
  closeMenu();
}

  return (
    <div className="account-workspace">
      <a className="skip-link" href="#account-main-content">
        Перейти к содержимому
      </a>

      <Sidebar
        activePage={activePage}
        onNavigate={handleNavigate}
        isOpen={isMenuOpen}
        onClose={closeMenu}
        navigationId="account-mobile-navigation"
      />

      <div className="app-main">
        <Header
          user={{ name: user.displayName, initials }}
          subtitle={user.email}
          onOpenMenu={() => setIsMenuOpen(true)}
          isMenuOpen={isMenuOpen}
          navigationId="account-mobile-navigation"
          showSearch={false}
          demoBadge={false}
        />

        <main
          id="account-main-content"
          className="page-content account-content"
          tabIndex={-1}
        >
          <div className="account-session-banner">
            <div className="account-connection">
              <CircleCheck size={21} aria-hidden="true" />
              <strong>Аккаунт подключён к серверу</strong>
            </div>

            <button
              type="button"
              className="secondary-button"
              onClick={onLogout}
            >
              <LogOut size={17} aria-hidden="true" />
              Выйти из аккаунта
            </button>
          </div>

          {message && <p className="form-error" role="alert">{message}</p>}

          <section className="panel account-overview">
            <p className="eyebrow">ЛИЧНОЕ УЧЕБНОЕ ПРОСТРАНСТВО</p>

            <h1 ref={headingRef} tabIndex={-1}>
              {materialSubjectId ? 'Материалы предмета' : pageTitles[activePage]}
            </h1>

            <div className="account-identity">
              <span className="profile-avatar account-avatar" aria-hidden="true">
                {initials}
              </span>

              <div>
                <strong>{user.displayName}</strong>
                <p>{user.email}</p>
              </div>
            </div>
          </section>

          {materialSubjectId ? (
            <AccountMaterials
              key={materialSubjectId}
              subjectId={materialSubjectId}
              stateRef={materialsRef}
              onBack={() => handleNavigate('subjects')}
              onAccessError={onAccessError}
              onAccessRestored={onAccessRestored}
            />
          ) : showSubjects ? (
            <AccountSubjects
              draftRef={draftRef}
              detailRef={detailRef}
              onOpenMaterials={openMaterials}
              onAccessError={onAccessError}
              onAccessRestored={onAccessRestored}
            />
          ) : (
            <section className="panel account-placeholder">
              <span className="icon-tile tone-purple">
                <Sparkles size={25} aria-hidden="true" />
              </span>
              <h2>{pageTitles[activePage]}</h2>
              <p>
                {activePage === 'settings'
                  ? 'Редактирование профиля добавим на следующем этапе.'
                  : 'Этот раздел добавим на следующих этапах разработки.'}
              </p>
            </section>
          )}

          <div className="panel account-placeholder account-demo-entry">
            <p>
              В демо можно попробовать предметы и PDF. Демо-предметы
              сохраняются отдельно в этом браузере, PDF — до перезагрузки страницы.
            </p>
            <button
              type="button"
              className="secondary-button"
              onClick={onOpenDemo}
            >
              Открыть демо-кабинет
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
