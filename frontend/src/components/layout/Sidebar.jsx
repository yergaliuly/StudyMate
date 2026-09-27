import { useEffect, useRef } from 'react';
import {
  GraduationCap,
  LayoutDashboard,
  BookOpen,
  FileText,
  Layers,
  ChartColumn,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';

const navigationItems = [
  {
    id: 'dashboard',
    label: 'Мой кабинет',
    icon: LayoutDashboard,
  },
  {
    id: 'subjects',
    label: 'Мои предметы',
    icon: BookOpen,
  },
  {
    id: 'lectures',
    label: 'Лекции',
    icon: FileText,
  },
  {
    id: 'flashcards',
    label: 'Карточки',
    icon: Layers,
  },
  {
    id: 'results',
    label: 'Результаты',
    icon: ChartColumn,
  },
  {
    id: 'settings',
    label: 'Настройки',
    icon: Settings,
  },
];

function SidebarContent({
  activePage,
  onNavigate,
  onClose,
  mobile = false,
}) {
  return (
    <>
      <div className="sidebar-header">
        <div className="brand">
          <span className="brand-mark">
            <GraduationCap size={25} aria-hidden="true" />
          </span>

          <span>
            Study<span className="brand-accent">Mate</span>
          </span>
        </div>

        {mobile && (
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть меню"
          >
            <X size={21} aria-hidden="true" />
          </button>
        )}
      </div>

      <p className="sidebar-label">УЧЕБНОЕ ПРОСТРАНСТВО</p>

      <nav className="sidebar-navigation" aria-label="Основная навигация">
        {navigationItems.map((item) => {
          const Icon = item.icon;
          const isActive = activePage === item.id;

          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${isActive ? 'nav-item--active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-tip">
        <Sparkles size={22} aria-hidden="true" />
        <h2>Маленькие шаги — большие цели</h2>
        <p>Возвращайся к учёбе в своём ритме. Мы поможем разобраться.</p>
      </div>

      <p className="sidebar-footer">StudyMate · пространство для знаний</p>
    </>
  );
}

export default function Sidebar({
  activePage,
  onNavigate,
  isOpen,
  onClose,
}) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;

    if (!dialog.open) {
      dialog.showModal();
    }

    document.body.style.overflow = 'hidden';

    // Закрываем мобильное меню при переходе к широкому экрану.
    const mediaQuery = window.matchMedia('(min-width: 961px)');

    const handleResize = () => {
      if (mediaQuery.matches) {
        onClose();
      }
    };

    mediaQuery.addEventListener('change', handleResize);
    handleResize();

    return () => {
      mediaQuery.removeEventListener('change', handleResize);
      document.body.style.overflow = previousOverflow;

      if (dialog.open) {
        dialog.close();
      }
    };
  }, [isOpen, onClose]);

  function handleBackdropClick(event) {
    if (event.target !== event.currentTarget) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();

    const clickedOutside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;

    if (clickedOutside) {
      onClose();
    }
  }

  return (
    <>
      <aside className="sidebar sidebar--desktop">
        <SidebarContent
          activePage={activePage}
          onNavigate={onNavigate}
        />
      </aside>

      <dialog
        ref={dialogRef}
        id="mobile-navigation"
        className="sidebar mobile-sidebar"
        aria-label="Меню StudyMate"
        onClick={handleBackdropClick}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <SidebarContent
          activePage={activePage}
          onNavigate={onNavigate}
          onClose={onClose}
          mobile
        />
      </dialog>
    </>
  );
}