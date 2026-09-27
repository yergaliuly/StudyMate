import { useCallback, useState } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';

import Sidebar from '../components/layout/Sidebar.jsx';
import Header from '../components/layout/Header.jsx';
import DashboardPage from '../pages/DashboardPage.jsx';

import SubjectFormModal from '../components/subjects/SubjectFormModal.jsx';
import DeleteSubjectModal from '../components/subjects/DeleteSubjectModal.jsx';

import { demoUser } from '../mocks/dashboard.js';
import SubjectPage from '../pages/SubjectPage.jsx';
import { demoLectures } from '../mocks/lectures.js';

import {
  loadSubjects,
  saveSubjects,
  createSubject,
  updateSubject,
  removeSubject,
} from '../services/subjectStorage.js';

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
  const [initialData] = useState(loadSubjects);

  const [subjects, setSubjects] = useState(initialData.subjects);
  const [storageWarning, setStorageWarning] = useState(initialData.warning);

  const [activePage, setActivePage] = useState('dashboard');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedSubjectId, setSelectedSubjectId] = useState(null);

  // null или объект с type: create, edit, delete.
  const [subjectDialog, setSubjectDialog] = useState(null);

  const selectedSubject =
    subjects.find((subject) => subject.id === selectedSubjectId) ?? null;

  const dialogSubject =
    subjects.find(
      (subject) => subject.id === subjectDialog?.subjectId,
    ) ?? null;

  const closeMenu = useCallback(() => {
    setIsMenuOpen(false);
  }, []);

  function handleNavigate(page) {
    setActivePage(page);
    setSelectedSubjectId(null);
    setSearchQuery('');
    closeMenu();
  }

  function handleSearchChange(value) {
    setSearchQuery(value);
    setSelectedSubjectId(null);

    if (activePage !== 'dashboard' && activePage !== 'subjects') {
      setActivePage('subjects');
    }
  }

  function handleOpenSubject(subject) {
    setSelectedSubjectId(subject.id);
    setActivePage('subjects');
    setSearchQuery('');
  }

  function applySubjects(updatedSubjects) {
    setSubjects(updatedSubjects);

    if (initialData.canPersist) {
      setStorageWarning(saveSubjects(updatedSubjects));
    }
  }

  function handleSaveSubject(values) {
    try {
      const isEditing = subjectDialog?.type === 'edit';

      const savedSubject = isEditing
        ? updateSubject(subjectDialog.subjectId, values, subjects)
        : createSubject(values, subjects);

      const updatedSubjects = isEditing
        ? subjects.map((subject) =>
            subject.id === savedSubject.id ? savedSubject : subject,
          )
        : [savedSubject, ...subjects];

      applySubjects(updatedSubjects);

      // После переименования карточка не должна исчезнуть
      // из-за старого поискового запроса.
      setSearchQuery('');

      return '';
    } catch (error) {
      return error instanceof Error
        ? error.message
        : 'Не удалось сохранить предмет.';
    }
  }

  function handleDeleteSubject() {
    if (subjectDialog?.type !== 'delete') {
      return 'Не выбран предмет для удаления.';
    }

    try {
      const subjectId = subjectDialog.subjectId;
      const updatedSubjects = removeSubject(subjectId, subjects);

      applySubjects(updatedSubjects);

      if (selectedSubjectId === subjectId) {
        setSelectedSubjectId(null);
      }

      return '';
    } catch (error) {
      return error instanceof Error
        ? error.message
        : 'Не удалось удалить предмет.';
    }
  }

  const showDashboard =
    activePage === 'dashboard' || activePage === 'subjects';

  const showSubjectForm =
    subjectDialog?.type === 'create' ||
    (subjectDialog?.type === 'edit' && dialogSubject !== null);

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
          {storageWarning && (
            <p className="storage-warning" role="alert">
              {storageWarning}
            </p>
          )}

          {selectedSubject ? (
            <SubjectPage
              key={selectedSubject.id}
              subject={selectedSubject}
              lectures={demoLectures.filter(
                (lecture) => lecture.subjectId === selectedSubject.id,
              )}
              onBack={() => handleNavigate('subjects')}
              onEdit={() =>
                setSubjectDialog({
                  type: 'edit',
                  subjectId: selectedSubject.id,
                })
              }
              onDelete={() =>
                setSubjectDialog({
                  type: 'delete',
                  subjectId: selectedSubject.id,
                })
              }
            />
          ) : showDashboard ? (
            <DashboardPage
              subjects={subjects}
              searchQuery={searchQuery}
              onOpenSubject={handleOpenSubject}
              onAddSubject={() =>
                setSubjectDialog({ type: 'create' })
              }
              onEditSubject={(subject) =>
                setSubjectDialog({
                  type: 'edit',
                  subjectId: subject.id,
                })
              }
              onDeleteSubject={(subject) =>
                setSubjectDialog({
                  type: 'delete',
                  subjectId: subject.id,
                })
              }
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

      {showSubjectForm && (
        <SubjectFormModal
          key={subjectDialog.subjectId ?? 'new-subject'}
          initialSubject={
            subjectDialog.type === 'edit' ? dialogSubject : null
          }
          onClose={() => setSubjectDialog(null)}
          onSave={handleSaveSubject}
        />
      )}

      {subjectDialog?.type === 'delete' && dialogSubject && (
        <DeleteSubjectModal
          subject={dialogSubject}
          onClose={() => setSubjectDialog(null)}
          onConfirm={handleDeleteSubject}
        />
      )}
    </>
  );
}