export default function App() {
  return (
    <main className="setup-page">
      <section className="setup-card" aria-labelledby="setup-title">
        <div className="brand">
          <span aria-hidden="true">🎓</span>

          <span>
            Study<span className="brand-accent">Mate</span>
          </span>
        </div>

        <p className="setup-badge">Первый этап · интерфейс</p>

        <h1 id="setup-title">Твой помощник в учёбе</h1>

        <p className="setup-description">
          Здесь появятся твои предметы, лекции, конспекты и тесты.
          Учись, понимай и двигайся к своим целям.
        </p>

        <p className="setup-note">
          Это проверка запуска. Учебные функции и ИИ пока не подключены.
        </p>
      </section>
    </main>
  );
}