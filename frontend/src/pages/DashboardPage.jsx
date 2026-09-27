import {
  BookOpen,
  ClipboardCheck,
  Layers,
  Sparkles,
  Plus,
  Info,
} from 'lucide-react';
import SubjectCard from '../components/ui/SubjectCard.jsx';
import { demoProgress } from '../mocks/dashboard.js';

const statistics = [
  {
    id: 'lectures',
    value: 3,
    label: 'лекции изучено',
    icon: BookOpen,
    tone: 'blue',
  },
  {
    id: 'tests',
    value: 2,
    label: 'теста пройдено',
    icon: ClipboardCheck,
    tone: 'purple',
  },
  {
    id: 'cards',
    value: 18,
    label: 'карточек повторено',
    icon: Layers,
    tone: 'green',
  },
];

export default function DashboardPage({
  subjects,
  searchQuery,
  onOpenSubject,
  onAddSubject,
  onEditSubject,
  onDeleteSubject,
  subjectsOnly = false,
}) {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredSubjects = subjects.filter((subject) => {
    const searchableText =
      `${subject.title} ${subject.description}`.toLowerCase();

    return searchableText.includes(normalizedQuery);
  });

  const today = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());

  return (
    <div className="dashboard">
      <header className="welcome">
        <div>
          <p className="eyebrow">ТВОЁ ПРОСТРАНСТВО ДЛЯ РОСТА</p>

          <h1>
            {subjectsOnly ? 'Мои предметы' : 'Добро пожаловать!'}
          </h1>

          <p className="welcome-description">
            {subjectsOnly
              ? 'Все учебные материалы — в одном месте.'
              : 'Большие цели начинаются с регулярной учёбы.'}
          </p>
        </div>

        <p className="welcome-quote">
          Лучше понимать сегодня,
          <br />
          чем переживать завтра.
        </p>
      </header>

      {!subjectsOnly && (
        <div className="overview-grid">
          <section className="panel progress-panel">
            <div className="panel-heading">
              <div>
                <h2>Сегодняшний прогресс</h2>
                <p className="muted">{today}</p>
              </div>

              <span className="demo-badge">Пример</span>
            </div>

            <div className="progress-content">
              <div
                className="progress-ring"
                style={{ '--progress-angle': `${demoProgress * 3.6}deg` }}
                role="img"
                aria-label={`Демонстрационный прогресс: ${demoProgress}%`}
              >
                <div className="progress-ring-inner">
                  <strong>{demoProgress}%</strong>
                  <span>плана на день</span>
                </div>
              </div>

              <div className="stats-grid">
                {statistics.map((stat) => {
                  const Icon = stat.icon;

                  return (
                    <div
                      key={stat.id}
                      className={`stat-tile tone-${stat.tone}`}
                    >
                      <Icon size={23} aria-hidden="true" />
                      <strong>{stat.value}</strong>
                      <span>{stat.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <aside className="motivation-panel">
            <Sparkles size={25} aria-hidden="true" />
            <h2>Ты на правильном пути!</h2>
            <p>Каждая новая тема — ещё один шаг вперёд.</p>

            <div className="mountains" aria-hidden="true">
              <span className="mountain mountain--one" />
              <span className="mountain mountain--two" />
              <span className="mountain mountain--three" />
            </div>
          </aside>
        </div>
      )}

      <section aria-labelledby="subjects-heading">
        <div className="section-heading">
          <div>
            <h2 id="subjects-heading">
              {subjectsOnly ? 'Все предметы' : 'Мои предметы'}
            </h2>

            <p className="muted">
              Выбери предмет и продолжай изучение
            </p>
          </div>

          <button
            type="button"
            className="primary-button"
            onClick={onAddSubject}
          >
            <Plus size={18} aria-hidden="true" />
            Добавить предмет
          </button>
        </div>

        {filteredSubjects.length > 0 ? (
          <div className="subjects-grid">
            {filteredSubjects.map((subject) => (
              <SubjectCard
                key={subject.id}
                subject={subject}
                onOpen={onOpenSubject}
                onEdit={onEditSubject}
                onDelete={onDeleteSubject}
              />
            ))}
          </div>
        ) : (
          <div className="panel empty-state" role="status">
            <BookOpen size={30} aria-hidden="true" />

            <h3>
              {subjects.length === 0
                ? 'Пока нет предметов'
                : 'Предметы не найдены'}
            </h3>

            <p>
              {subjects.length === 0
                ? 'Нажми «Добавить предмет», чтобы создать первый предмет.'
                : 'Попробуй другое название или очисти строку поиска.'}
            </p>
          </div>
        )}
      </section>

      <div className="demo-notice">
        <Info size={19} aria-hidden="true" />

        <p>
          Исходные предметы и статистика показаны для примера.
          Новые предметы сохраняются локально в этом браузере.
          Сервер, загрузка лекций и настоящий прогресс пока не подключены.
        </p>
      </div>
    </div>
  );
}