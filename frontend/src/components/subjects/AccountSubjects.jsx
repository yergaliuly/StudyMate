import { useEffect, useRef, useState } from 'react';
import { BookOpen, Plus, RefreshCw, Search } from 'lucide-react';

import { subjectApi } from '../../services/subjectApi.js';
import SubjectCard from '../ui/SubjectCard.jsx';
import AccountSubjectForm from './AccountSubjectForm.jsx';
import AccountSubjectDetails from './AccountSubjectDetails.jsx';
import '../../styles/subjects.css';

const PAGE_SIZE = 20;

function isAccessError(error) {
  return (error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
    || (error?.status === 403 && error.code === 'CSRF_INVALID');
}

function listErrorMessage(error) {
  if (error?.code === 'INVALID_RESPONSE') {
    return 'Не удалось прочитать список предметов. Попробуй обновить его.';
  }

  return 'Не удалось загрузить предметы. Проверь соединение и попробуй снова.';
}

export default function AccountSubjects({
  draftRef,
  detailRef,
  onAccessError,
  onAccessRestored,
  onOpenMaterials,
}) {
  const [searchInput, setSearchInput] = useState('');
  const [request, setRequest] = useState({ q: '', page: 1, revision: 0, clamped: false });
  const [list, setList] = useState({ status: 'loading', key: '', subjects: [], meta: null });
  const [isFormOpen, setIsFormOpen] = useState(() => Boolean(draftRef.current?.open));
  const [selectedId, setSelectedId] = useState(() => detailRef.current?.id ?? null);
  const [notice, setNotice] = useState('');
  const addButtonRef = useRef(null);
  const returnFocusRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const accessErrorRef = useRef(onAccessError);
  const accessRestoredRef = useRef(onAccessRestored);
  const key = JSON.stringify(request);
  const pendingSearch = searchInput.trim() !== request.q;
  const loading = pendingSearch || list.key !== key || list.status === 'loading';
  const ready = !loading && list.status === 'ready';
  const totalPages = ready ? Math.max(1, Math.ceil(list.meta.total / list.meta.pageSize)) : 1;

  useEffect(() => {
    if (!selectedId && returnFocusRef.current) {
      returnFocusRef.current = false;
      // Refresh replaces the original card, so use a stable control in the list.
      addButtonRef.current?.focus();
    }
  }, [selectedId]);

  useEffect(() => {
    accessErrorRef.current = onAccessError;
    accessRestoredRef.current = onAccessRestored;
  }, [onAccessError, onAccessRestored]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = searchInput.trim();
      setRequest((current) => current.q === q
        ? current
        : { q, page: 1, revision: current.revision, clamped: false });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++requestGenerationRef.current;
    const current = () => !controller.signal.aborted && requestGenerationRef.current === generation;

    setList({ status: 'loading', key, subjects: [], meta: null });

    async function loadSubjects() {
      try {
        const result = await subjectApi.list({
          q: request.q,
          page: request.page,
          pageSize: PAGE_SIZE,
          signal: controller.signal,
        });
        if (!current()) return;

        const lastPage = Math.max(1, Math.ceil(result.meta.total / result.meta.pageSize));
        if (request.page > lastPage) {
          if (!request.clamped) {
            // Another request may have removed the last page. Correct it once;
            // continuous changes must not cause an unbounded request loop.
            setRequest((value) => ({ ...value, page: lastPage, clamped: true }));
          } else {
            setList({
              status: 'error', key, subjects: [], meta: null,
              message: 'Список предметов изменился. Обнови список.',
            });
          }
          return;
        }

        accessRestoredRef.current?.();
        setList({ status: 'ready', key, ...result });
      } catch (error) {
        if (!current()) return;

        if (isAccessError(error)) {
          accessErrorRef.current(error);
          return;
        }

        setList({ status: 'error', key, subjects: [], meta: null, message: listErrorMessage(error) });
      }
    }

    loadSubjects();
    return () => {
      controller.abort();
      requestGenerationRef.current += 1;
    };
  }, [key, request]);

  function updateSearch(value) {
    setSearchInput(value);
    setNotice('');
  }

  function refreshList() {
    setRequest((current) => ({
      ...current,
      revision: current.revision + 1,
      clamped: false,
    }));
  }

  function changePage(page) {
    setNotice('');
    setRequest((current) => ({ ...current, page, clamped: false }));
  }

  function openForm() {
    if (draftRef.current) draftRef.current.open = true;
    setIsFormOpen(true);
  }

  function closeForm() {
    if (draftRef.current) draftRef.current.open = false;
    setIsFormOpen(false);
    queueMicrotask(() => addButtonRef.current?.focus());
  }

  function handleCreated() {
    closeForm();
    setSearchInput('');
    setNotice('Предмет сохранён. Список обновляется.');
    // A replayed creation response can be historical. Always load current data.
    setRequest((current) => ({ q: '', page: 1, revision: current.revision + 1, clamped: false }));
  }

  function openDetails(subject, mode = 'view') {
    detailRef.current = { id: subject.id, mode };
    setSelectedId(subject.id);
    setNotice('');
  }

  function closeDetails() {
    returnFocusRef.current = true;
    detailRef.current = null;
    setSelectedId(null);
    refreshList();
  }

  function handleSubjectChanged(message) {
    setNotice(message);
    refreshList();
  }

  return (
    <section className="account-subjects" aria-labelledby="account-subjects-heading">
      <div className="account-subjects-heading">
        <div>
          <h2 id="account-subjects-heading">Предметы аккаунта</h2>
          <p className="muted">Твои предметы сохраняются в аккаунте.</p>
        </div>

        <button ref={addButtonRef} type="button" className="primary-button" onClick={openForm}>
          <Plus size={18} aria-hidden="true" />
          Добавить предмет
        </button>
      </div>

      <div className="account-subjects-toolbar">
        <label className="account-subject-search">
          <Search size={19} aria-hidden="true" />
          <span className="visually-hidden">Поиск предметов</span>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => updateSearch(event.target.value)}
            maxLength={160}
            placeholder="Найти по названию или описанию"
          />
        </label>

        <button
          type="button"
          className="secondary-button"
          onClick={refreshList}
          disabled={loading}
        >
          <RefreshCw size={16} aria-hidden="true" />
          Обновить список
        </button>
      </div>

      {notice && <p className="account-subject-notice" role="status">{notice}</p>}

      <div className="account-subject-results" aria-busy={loading}>
        {loading ? (
          <p className="panel account-subject-state" role="status">Загружаем предметы…</p>
        ) : list.status === 'error' ? (
          <div className="panel account-subject-state">
            <p className="form-error" role="alert">{list.message}</p>
            <button type="button" className="secondary-button" onClick={refreshList}>
              Повторить загрузку
            </button>
          </div>
        ) : list.subjects.length === 0 ? (
          <div className="panel empty-state">
            <BookOpen size={30} aria-hidden="true" />
            <h3>{list.meta.total > 0 ? 'На этой странице нет предметов' : request.q ? 'Ничего не найдено' : 'Пока нет предметов'}</h3>
            <p>{list.meta.total > 0
              ? 'Обнови список, чтобы получить актуальные данные.'
              : request.q ? 'Попробуй другой запрос.' : 'Добавь первый предмет, чтобы начать.'}</p>
          </div>
        ) : (
          <div className="subjects-grid">
            {list.subjects.map((subject) => (
              <SubjectCard
                key={subject.id}
                subject={subject}
                isDemo={false}
                onOpen={(item) => openDetails(item)}
                onEdit={(item) => openDetails(item, 'edit')}
                onDelete={(item) => openDetails(item, 'delete')}
              />
            ))}
          </div>
        )}
      </div>

      {ready && list.meta.total > 0 && (
        <nav className="account-subject-pagination" aria-label="Страницы предметов">
          <p>Всего: {list.meta.total}. Страница {list.meta.page} из {totalPages}</p>
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={list.meta.page <= 1}
              onClick={() => changePage(list.meta.page - 1)}
            >
              Предыдущая страница
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={list.meta.page >= totalPages}
              onClick={() => changePage(list.meta.page + 1)}
            >
              Следующая страница
            </button>
          </div>
        </nav>
      )}

      {isFormOpen && (
        <AccountSubjectForm
          draftRef={draftRef}
          onClose={closeForm}
          onCreated={handleCreated}
          onAccessError={onAccessError}
        />
      )}

      {selectedId && (
        <AccountSubjectDetails
          key={selectedId}
          detailRef={detailRef}
          onOpenMaterials={onOpenMaterials}
          onClose={closeDetails}
          onChanged={handleSubjectChanged}
          onAccessError={onAccessError}
          onAccessRestored={onAccessRestored}
        />
      )}
    </section>
  );
}
