import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, RefreshCw, Search } from 'lucide-react';

import { subjectApi } from '../../services/subjectApi.js';
import { materialApi } from '../../services/materialApi.js';
import { storageApi } from '../../services/storageApi.js';
import { formatBytes } from '../../utils/formatBytes.js';
import StorageUsage from './StorageUsage.jsx';
import MaterialUploadForm from './MaterialUploadForm.jsx';
import MaterialTextPanel, { processingLabels } from './MaterialTextPanel.jsx';
import '../../styles/accountMaterials.css';

const PAGE_SIZE = 20;

const statusLabels = {
  uploading: 'Сохранение не завершено',
  stored: 'Сохранён',
  deleting: 'Удаление не завершено',
};

export default function AccountMaterials({
  subjectId,
  stateRef,
  onBack,
  onAccessError,
  onAccessRestored,
}) {
  const scope = useRef(stateRef.current).current;
  const record = useRef(scope.records[subjectId]).current;
  const [selectedMaterialId, setSelectedMaterialId] = useState(
  record.selectedMaterialId ?? null,
  );
  const materialOpenerRef = useRef(null);
  const materialSearchRef = useRef(null);

  const runtime = useRef({
    mounted: false,
    blocked: false,
    reviewing: false,
    requests: new Map(),
    ready: new Set(),
  }).current;

  const callbacks = useRef({});
  callbacks.current = { onAccessError, onAccessRestored };

  const [reviewStatus, setReviewStatus] = useState('idle');
  const [subject, setSubject] = useState({ status: 'loading' });
  const [storage, setStorage] = useState({ status: 'loading' });
  const [list, setList] = useState({ status: 'loading', key: '' });

  const [subjectRevision, setSubjectRevision] = useState(0);
  const [storageRevision, setStorageRevision] = useState(0);
  const [search, setSearch] = useState(record.search);

  const [request, setRequest] = useState({
    q: record.q,
    page: record.page,
    revision: 0,
    clamped: false,
  });

  const key = JSON.stringify(request);

  const loading = search.trim() !== request.q
    || list.key !== key
    || list.status === 'loading';

  const ready = !loading && list.status === 'ready';

  const canUseMaterials = useCallback(
    () => runtime.mounted
      && !runtime.blocked
      && stateRef.current === scope
      && scope.selectedSubjectId === subjectId
      && scope.records[subjectId] === record,
    [runtime, stateRef, scope, subjectId, record],
  );

  const canUseMaterial = useCallback(
  (id) => canUseMaterials() && record.selectedMaterialId === id,
  [canUseMaterials, record],
  );

  useEffect(() => {
    runtime.mounted = true;
    runtime.blocked = false;
    runtime.ready.clear();

    return () => {
      runtime.mounted = false;

      for (const controller of runtime.requests.values()) {
        controller.abort();
      }

      runtime.requests.clear();
    };
  }, [runtime]);

  const read = useCallback((slot, load, publish) => {
    const active = () => runtime.mounted
      && !runtime.blocked
      && stateRef.current === scope
      && scope.selectedSubjectId === subjectId
      && scope.records[subjectId] === record;

    if (!active()) return () => {};

    runtime.requests.get(slot)?.abort();

    const controller = new AbortController();
    runtime.requests.set(slot, controller);
    runtime.ready.delete(slot);

    if (!runtime.reviewing) {
      setReviewStatus('idle');
    }

    const current = () => active()
      && !controller.signal.aborted
      && runtime.requests.get(slot) === controller;

    function block(status) {
      runtime.blocked = true;

      for (const pending of runtime.requests.values()) {
        pending.abort();
      }

      runtime.requests.clear();
      runtime.ready.clear();
      runtime.reviewing = false;

      setReviewStatus('error');
      setSubject({ status });
      setStorage({ status: 'loading' });
      setList({ status: 'loading', key: '' });
    }

    publish({ status: 'loading' });

    void (async () => {
      try {
        const data = await load(controller.signal);
        if (!current()) return;

        if (publish({ status: 'ready', data }) !== false) {
          runtime.ready.add(slot);
        }
      } catch (error) {
        if (!current()) return;

        const accessError = (
          error?.status === 401
          && error.code === 'AUTHENTICATION_REQUIRED'
        ) || (
          error?.status === 403
          && error.code === 'CSRF_INVALID'
        ) || error?.code === 'CSRF_NOT_INITIALIZED';

        if (accessError) {
          block('checking');
          callbacks.current.onAccessError?.(error);
        } else if (
          slot !== 'storage'
          && error?.status === 404
          && error.code === 'SUBJECT_NOT_FOUND'
        ) {
          block('unavailable');
        } else {
          if (runtime.reviewing) {
            runtime.reviewing = false;
            setReviewStatus('error');
          }

          publish({ status: 'error' });
        }
      } finally {
        if (runtime.requests.get(slot) === controller) {
          runtime.requests.delete(slot);

          if (
            active()
            && runtime.requests.size === 0
            && runtime.ready.size === 3
          ) {
            if (runtime.reviewing) {
              runtime.reviewing = false;
              setReviewStatus('ready');
            }

            callbacks.current.onAccessRestored?.();
          }
        }
      }
    })();

    return () => {
      controller.abort();

      if (runtime.requests.get(slot) === controller) {
        runtime.requests.delete(slot);
      }
    };
  }, [runtime, stateRef, scope, record, subjectId]);

  useEffect(() => read(
    'subject',
    (signal) => subjectApi.getById(subjectId, { signal }),
    setSubject,
  ), [read, subjectId, subjectRevision]);

  useEffect(() => read(
    'storage',
    (signal) => storageApi.usage({ signal }),
    setStorage,
  ), [read, storageRevision]);

  useEffect(() => read(
    'list',
    (signal) => materialApi.list({
      subjectId,
      q: request.q,
      page: request.page,
      pageSize: PAGE_SIZE,
      signal,
    }),
    (result) => {
      if (result.status === 'ready') {
        const { meta } = result.data;
        const lastPage = Math.max(1, Math.ceil(meta.total / meta.pageSize));

        if (request.page > lastPage) {
          if (!request.clamped) {
            record.page = lastPage;

            setRequest((value) => value === request
              ? { ...value, page: lastPage, clamped: true }
              : value);
          } else {
            runtime.reviewing = false;
            setReviewStatus('error');
            setList({ status: 'error', key });
          }

          return false;
        }
      }

      setList({ ...result, key });
    },
  ), [read, subjectId, request, key, record, runtime]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (
        !runtime.mounted
        || runtime.blocked
        || stateRef.current !== scope
        || scope.selectedSubjectId !== subjectId
        || scope.records[subjectId] !== record
      ) {
        return;
      }

      const q = search.trim();
      if (q === request.q) return;

      record.q = q;
      record.page = 1;

      setRequest((value) => ({
        q,
        page: 1,
        revision: value.revision,
        clamped: false,
      }));
    }, 300);

    return () => window.clearTimeout(timer);
  }, [search, request.q, runtime, stateRef, scope, subjectId, record]);

  function refreshList() {
    setRequest((value) => ({
      ...value,
      revision: value.revision + 1,
      clamped: false,
    }));
  }

  function changePage(page) {
    record.page = page;
    setRequest((value) => ({ ...value, page, clamped: false }));
  }

  function resetReview() {
    if (!canUseMaterials()) return;

    runtime.reviewing = false;
    setReviewStatus('idle');
  }

  function refreshMaterials() {
    if (!canUseMaterials()) return;

    for (const controller of runtime.requests.values()) {
      controller.abort();
    }

    runtime.requests.clear();
    runtime.ready.clear();
    runtime.reviewing = true;

    setReviewStatus('loading');

    record.search = '';
    record.q = '';
    record.page = 1;

    setSearch('');
    setSubject({ status: 'loading' });
    setStorage({ status: 'loading' });

    setSubjectRevision((value) => value + 1);
    setStorageRevision((value) => value + 1);

    setRequest((value) => ({
      q: '',
      page: 1,
      revision: value.revision + 1,
      clamped: false,
    }));
  }

  function blockUpload(status, error) {
    if (!canUseMaterials()) return;

    runtime.blocked = true;
    runtime.reviewing = false;

    for (const controller of runtime.requests.values()) {
      controller.abort();
    }

    runtime.requests.clear();
    runtime.ready.clear();

    setReviewStatus('error');
    setSubject({ status });
    setStorage({ status: 'loading' });
    setList({ status: 'loading', key: '' });

    if (status === 'checking') {
      callbacks.current.onAccessError?.(error);
    }
  }

  function openMaterial(id, button) {
  if (!canUseMaterials()) return;

  materialOpenerRef.current = button;
  record.selectedMaterialId = id;
  setSelectedMaterialId(id);
}

function closeMaterial() {
  if (!canUseMaterials()) return;

  record.selectedMaterialId = null;
  setSelectedMaterialId(null);

  window.requestAnimationFrame(() => {
    if (!canUseMaterials() || record.selectedMaterialId != null) return;

    const button = materialOpenerRef.current;
    if (button?.isConnected) button.focus();
    else materialSearchRef.current?.focus();
  });
}

  function handleMaterialUploaded(uploaded) {
  if (!canUseMaterials()) return;

  openMaterial(uploaded.id, null);
  refreshMaterials();
}

  const totalPages = ready
    ? Math.max(1, Math.ceil(list.data.meta.total / list.data.meta.pageSize))
    : 1;

  return (
    <section className="account-materials" aria-label="Файлы предмета">
      <div>
        <button type="button" className="secondary-button" onClick={onBack}>
          <ArrowLeft size={17} aria-hidden="true" />
          Назад к предметам
        </button>
      </div>

      {subject.status === 'loading' || subject.status === 'checking' ? (
        <p className="panel account-material-state" role="status">
          {subject.status === 'checking'
            ? 'Проверяем сессию…'
            : 'Загружаем предмет…'}
        </p>
      ) : subject.status === 'unavailable' ? (
        <div className="panel account-material-state">
          <h2>Предмет недоступен</h2>
          <p>Возможно, его удалили. Вернись к списку предметов.</p>
        </div>
      ) : subject.status === 'error' ? (
        <div className="panel account-material-state">
          <p className="form-error" role="alert">
            Не удалось загрузить предмет.
          </p>

          <button
            type="button"
            className="secondary-button"
            onClick={() => setSubjectRevision((value) => value + 1)}
          >
            Повторить загрузку предмета
          </button>
        </div>
      ) : (
        <>
          <div className="panel account-material-intro">
            <p className="eyebrow">МАТЕРИАЛЫ ПРЕДМЕТА</p>
            <h2>{subject.data.title}</h2>
            <p>{subject.data.description || 'Описание пока не добавлено.'}</p>
          </div>

          {selectedMaterialId && (
          <MaterialTextPanel
            key={selectedMaterialId}
            materialId={selectedMaterialId}
            subjectId={subjectId}
            record={record}
            canAct={canUseMaterial}
            onClose={closeMaterial}
            onAccessError={(error) => blockUpload('checking', error)}
            onMaterialRead={refreshList}
          />
        )}

          <StorageUsage
            status={storage.status}
            usage={storage.data ?? null}
            onRefresh={() => setStorageRevision((value) => value + 1)}
          />

          <MaterialUploadForm
            subjectId={subjectId}
            record={record}
            usage={storage.status === 'ready' ? storage.data : null}
            canAct={canUseMaterials}
            reviewStatus={reviewStatus}
            onStart={resetReview}
            onUploaded={handleMaterialUploaded}
            onReview={refreshMaterials}
            onAccessError={(error) => blockUpload('checking', error)}
            onUnavailable={() => blockUpload('unavailable')}
          />

          <div className="account-material-toolbar">
            <label className="account-material-search">
              <Search size={19} aria-hidden="true" />
              <span className="visually-hidden">Поиск материалов</span>

              <input
                ref={materialSearchRef}
                type="search"
                maxLength={160}
                value={search}
                placeholder="Найти материал по названию"
                onChange={(event) => {
                  record.search = event.target.value;
                  setSearch(event.target.value);
                }}
              />
            </label>

            <button
              type="button"
              className="secondary-button"
              disabled={loading}
              onClick={refreshList}
            >
              <RefreshCw size={16} aria-hidden="true" />
              Обновить список
            </button>
          </div>

          <div aria-busy={loading}>
            {loading ? (
              <p className="panel account-material-state" role="status">
                Загружаем материалы…
              </p>
            ) : list.status === 'error' ? (
              <div className="panel account-material-state">
                <p className="form-error" role="alert">
                  Не удалось получить актуальный список материалов.
                </p>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={refreshList}
                >
                  Повторить загрузку материалов
                </button>
              </div>
            ) : list.data.materials.length === 0 ? (
              <div className="panel account-material-state">
                <FileText size={30} aria-hidden="true" />

                <h3>
                  {list.data.meta.total > 0
                    ? 'На этой странице нет материалов'
                    : request.q ? 'Ничего не найдено' : 'Пока нет материалов'}
                </h3>

                <p>
                  {list.data.meta.total > 0
                    ? 'Обнови список.'
                    : request.q
                      ? 'Попробуй другой запрос.'
                      : 'Здесь будут PDF этого предмета.'}
                </p>
              </div>
            ) : (
              <ul className="account-material-grid">
                {list.data.materials.map((material) => (
                  <li key={material.id} className="panel account-material-card">
                    <div className="account-material-card-heading">
                      <FileText size={24} aria-hidden="true" />

                      <span
                        className={'account-material-status status-' + material.status}
                      >
                        {statusLabels[material.status]}
                      </span>
                    </div>

                    <h3>{material.title}</h3>
                    <p className="account-material-filename">
                      {material.fileName}
                    </p>
                    <p className="account-material-size">
                      PDF · {formatBytes(material.sizeBytes)}
                    </p>
                    <p className="account-material-processing">
                      {processingLabels[material.processingStatus]}
                    </p>

                    <button
                      type="button"
                      className="secondary-button"
                      disabled={material.status !== 'stored'}
                      aria-expanded={selectedMaterialId === material.id}
                      aria-label={'Открыть обработку и текст «' + material.title + '»'}
                      onClick={(event) => openMaterial(material.id, event.currentTarget)}
                    >
                      Обработка и текст
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {ready && list.data.meta.total > 0 && (
            <nav
              className="account-material-pagination"
              aria-label="Страницы материалов"
            >
              <p>
                Всего: {list.data.meta.total}.
                {' '}Страница {list.data.meta.page} из {totalPages}
              </p>

              <div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={list.data.meta.page <= 1}
                  onClick={() => changePage(list.data.meta.page - 1)}
                >
                  Предыдущая страница
                </button>

                <button
                  type="button"
                  className="secondary-button"
                  disabled={list.data.meta.page >= totalPages}
                  onClick={() => changePage(list.data.meta.page + 1)}
                >
                  Следующая страница
                </button>
              </div>
            </nav>
          )}
        </>
      )}
    </section>
  );
}