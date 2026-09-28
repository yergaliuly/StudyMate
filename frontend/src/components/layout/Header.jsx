import { Search, Bell, Menu } from 'lucide-react';

export default function Header({
  user,
  searchQuery,
  onSearchChange,
  onOpenMenu,
  isMenuOpen,
  navigationId = 'mobile-navigation',
  showSearch = true,
  demoBadge = true,
  subtitle = 'Учебный профиль',
}) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button mobile-menu-button"
        onClick={onOpenMenu}
        aria-label="Открыть меню"
        aria-haspopup="dialog"
        aria-controls={navigationId}
        aria-expanded={isMenuOpen}
      >
        <Menu size={22} aria-hidden="true" />
      </button>

      {showSearch ? (
        <label className="search-box">
          <Search size={18} aria-hidden="true" />

          <span className="visually-hidden">Поиск предметов</span>

          <input
            type="search"
            placeholder="Поиск по предметам..."
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
      ) : (
        <span className="account-header-title">Личный кабинет</span>
      )}

      <div className="topbar-actions">
        {demoBadge && <span className="demo-badge header-demo">Демо</span>}

        <button
          type="button"
          className="icon-button notification-button"
          aria-label="Уведомления пока недоступны"
          title="Уведомления добавим позже"
          disabled
        >
          <Bell size={20} aria-hidden="true" />
        </button>

        <div className="profile">
          <span className="profile-avatar" aria-hidden="true">
            {user.initials}
          </span>

          <div className="profile-copy">
            <strong>{user.name}</strong>
            <span>{subtitle}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
