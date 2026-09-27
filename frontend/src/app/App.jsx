import { useCallback, useState } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import Sidebar from '../components/layout/Sidebar.jsx';
import Header from '../components/layout/Header.jsx';
import DashboardPage from '../pages/DashboardPage.jsx';
import { demoUser } from '../mocks/dashboard.js';

const pageTitles = {
  dashboard: 'Мой кабинет',
  subjects: 'Мои предметы',
  lectures: 'Лекции',
  flashcards: 'Карточки',
  results: 'Результаты',
  settings: 'Настройки',
};

function PlaceholderPage({ title, description, onBack }) {
  return (
    <section className="panel placeholder-page">
      <span className="icon-tile tone-purple">
        <Sparkles size={26} aria-hidden="true" />
      </span>

      <p className="eyebrow">СЛЕДУЮЩИЕ ЭТАПЫ РАЗРАБОТКИ</p>

      <h1>{title}</h1>
      <p>{description}</p>

      <button
        type="button"
        className="primary-button"
        onClick={onBack}
      >
        Вернуться в кабинет
        <ArrowRight size={18} aria-hidden="true" />
      </button>
    </section>
  );
}

export default function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSubject, setSelectedSubject] = useState(null);

  const closeMenu = useCallback(() => {
    setIsMenuOpen(false);
  }, []);

  function handleNavigate(page) {
    setActivePage(page);
    setSelectedSubject(null);
    setSearchQuery('');
    closeMenu();
  }

  function handleSearchChange(value) {
    setSearchQuery(value);
    setSelectedSubject(null);

    if (activePage !== 'dashboard' && activePage !== 'subjects') {
      setActivePage('subjects');
    }
  }

  function handleOpenSubject(subject) {
    setSelectedSubject(subject);
    setActivePage('subjects');
    setSearchQuery('');
  }

  const showDashboard =
    activePage === 'dashboard' || activePage === 'subjects';

  return (
    <>
      <a className="skip-link" href="#main-content">
        Перейти к содержимому
      </a>

      <Sidebar
        activePage={activePage}
        onNavigate={handleNavigate}
        isOpen={isMenuOpen}
        onClose={closeMenu}
      />

      <div className="app-main">
        <Header
          user={demoUser}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          onOpenMenu={() => setIsMenuOpen(true)}
          isMenuOpen={isMenuOpen}
        />

        <main
          id="main-content"
          className="page-content"
          tabIndex={-1}
        >
          {selectedSubject ? (
            <PlaceholderPage
              title={selectedSubject.title}
              description="Здесь будут лекции, конспекты и тесты по предмету. Страницу предмета реализуем следующим этапом."
              onBack={() => handleNavigate('dashboard')}
            />
          ) : showDashboard ? (
            <DashboardPage
              searchQuery={searchQuery}
              onOpenSubject={handleOpenSubject}
              subjectsOnly={activePage === 'subjects'}
            />
          ) : (
            <PlaceholderPage
              title={pageTitles[activePage]}
              description="Навигация уже работает. Содержимое этого раздела добавим на следующих этапах разработки."
              onBack={() => handleNavigate('dashboard')}
            />
          )}
        </main>
      </div>
    </>
  );
}