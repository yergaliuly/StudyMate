import { useEffect, useId, useRef, useState } from "react";
import { createMaterialTextReader } from "../../services/materialTextReader.js";
import "../../styles/materialText.css";
import MaterialProcessAction from './MaterialProcessAction.jsx';
import MaterialDownloadAction from './MaterialDownloadAction.jsx';
import MaterialRenameAction from './MaterialRenameAction.jsx';
import {
  reconcileMaterialProcessing,
} from '../../services/materialProcessingAction.js';

export const processingLabels = {
  not_started: "Обработка не запускалась",
  queued: "В очереди",
  running: "Извлекаем текст",
  ready: "Текст готов",
  failed: "Ошибка обработки",
  cancelled: "Обработка отменена",
};

const processingErrors = {
  PDF_INVALID: "PDF повреждён или имеет неподдерживаемую структуру.",
  PDF_ENCRYPTED: "PDF зашифрован. Для обработки нужна незашифрованная копия.",
  PDF_NO_TEXT:
    "В PDF нет текстового слоя. Распознавание сканов пока не подключено.",
  PDF_TOO_MANY_PAGES: "В PDF больше 200 страниц.",
  PDF_TEXT_LIMIT: "Объём текста превышает допустимый предел.",
  PDF_TIMEOUT: "Не удалось извлечь текст за отведённое время.",
  PDF_RESOURCE_LIMIT: "Для обработки этого PDF не хватило памяти.",
  PDF_WORKER_FAILED: "Обработчик PDF завершился с ошибкой.",
  PDF_ORIGINAL_MISMATCH: "Исходный файл не прошёл проверку целостности.",
  JOB_TEMPORARY_FAILURE: "При обработке произошёл временный сбой.",
  JOB_PROCESSING_FAILED: "Не удалось обработать материал.",
  JOB_ATTEMPTS_EXHAUSTED: "Попытки обработки завершились неудачно.",
  JOB_LEASE_EXPIRED: "Обработчик перестал отвечать.",
  JOB_OUTCOME_UNKNOWN: "Результат обработки не подтверждён. Обнови материал.",
};

function initialView() {
  return {
    status: "loading",
    material: null,
    jobStatus: null,
    watchError: null,
    pages: { status: "idle" },
  };
}

export default function MaterialTextPanel({
  materialId,
  subjectId,
  record,
  canAct,
  onClose,
  onAccessError,
  onMaterialRead,
}) {
  const headingId = useId();
  const headingRef = useRef(null);
  const readerRef = useRef(null);
  const callbacksRef = useRef(null);
  const [view, setView] = useState(initialView);

  callbacksRef.current = {
  record,
  canAct,
  onAccessError,
  onMaterialRead,
};

  useEffect(() => {
    let active = true;
    setView(initialView());

    const reader = createMaterialTextReader({
      materialId,
      subjectId,
      canAct: (id) => active && callbacksRef.current.canAct(id),
      onChange: (next) => {
        if (active) setView(next);
      },
      onAccessError: (error) => {
        if (active) callbacksRef.current.onAccessError?.(error);
      },
      onMaterialRead: (freshMaterial) => {
        if (!active) return;

        reconcileMaterialProcessing(
          callbacksRef.current.record,
          freshMaterial,
        );

        callbacksRef.current.onMaterialRead?.();
      },
    });

    readerRef.current = reader;
    headingRef.current?.focus();
    reader.refresh();

    return () => {
      active = false;
      reader.stop();
      if (readerRef.current === reader) readerRef.current = null;
    };
  }, [materialId, subjectId, record]);

  const refresh = () => readerRef.current?.refresh();
  const handleRenamed = () => {
    if (!canAct(materialId)) return;
    headingRef.current?.focus({ preventScroll: true });
    refresh();
  };
  const readPage = (page) => {
    void readerRef.current?.readPage(page);
  };

  const busy = view.status === "loading" || view.status === "checking";
  const material = view.status === "ready" ? view.material : null;
  const processingStatus = view.jobStatus || material?.processingStatus;
  const pages = view.pages;
  const text = pages.status === "ready" ? pages.data : null;
  const lastPage = text ? Math.ceil(text.meta.total / text.meta.pageSize) : 1;
  const changed = ["TEXT_NOT_READY", "MATERIAL_NOT_AVAILABLE"].includes(
    pages.code,
  );

  if (!canAct(materialId)) return null;

  return (
    <section className="panel material-text-panel" aria-labelledby={headingId}>
      <div className="material-text-heading">
        <h3 id={headingId} ref={headingRef} tabIndex={-1}>
          Текст материала
        </h3>

        <div className="material-text-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={refresh}
            disabled={busy || view.status === "unavailable"}
          >
            Обновить материал
          </button>

          <button type="button" className="secondary-button" onClick={onClose}>
            Закрыть текст
          </button>
        </div>
      </div>

      {busy && (
        <p className="material-text-hint" role="status">
          {view.status === "checking"
            ? "Проверяем сессию…"
            : "Загружаем материал…"}
        </p>
      )}

      {view.status === "error" && (
        <p className="form-error" role="alert">
          Не удалось загрузить материал. Попробуй обновить его.
        </p>
      )}

      {view.status === "unavailable" && (
        <p className="material-text-hint" role="status">
          Материал больше недоступен. Закрой просмотр и обнови список.
        </p>
      )}

      {material && (
        <>
          <p className="material-text-title">{material.title}</p>

          {material.status !== "stored" ? (
            <p className="material-text-hint" role="status">
              {material.status === "deleting"
                ? "Материал удаляется. Его текст сейчас недоступен."
                : "Сохранение файла ещё не завершено. Текст пока недоступен."}
            </p>
          ) : (
            <>
              <MaterialDownloadAction
                material={material}
                canAct={canAct}
                onAccessError={onAccessError}
              />

              <MaterialRenameAction
                material={material}
                subjectId={subjectId}
                record={record}
                canAct={canAct}
                onRead={onMaterialRead}
                onSaved={handleRenamed}
                onAccessError={onAccessError}
              />

              <p className="material-text-processing" role="status">
                {processingLabels[processingStatus]}
              </p>

              <MaterialProcessAction
                material={material}
                record={record}
                canAct={canAct}
                onRefresh={refresh}
                onAccessError={onAccessError}
              />

              {processingStatus === "not_started" && (
                <p className="material-text-hint">
                  Извлечение текста для этого материала ещё не запускалось.
                </p>
              )}

              {processingStatus === "cancelled" && (
                <p className="material-text-hint">
                  Обработка отменена. Готовый текст сейчас недоступен.
                </p>
              )}

              {processingStatus === "failed" && (
                <p className="form-error" role="alert">
                  {processingErrors[material.processingError?.code] ||
                    "Не удалось извлечь текст из PDF."}
                </p>
              )}

              {["queued", "running"].includes(processingStatus) && (
                <p className="material-text-hint">
                  {view.watchError
                    ? "Проверка состояния остановлена. Нажми «Обновить материал», чтобы продолжить."
                    : "Состояние обновляется автоматически. После закрытия панели обработка продолжится."}
                </p>
              )}

              {processingStatus === "ready" && (
                <div className="material-text-content">
                  {pages.status === "loading" && (
                    <p className="material-text-hint" role="status">
                      Загружаем страницы…
                    </p>
                  )}

                  {pages.status === "error" && (
                    <div className="material-text-state">
                      <p className="form-error" role="alert">
                        {changed
                          ? "Состояние материала изменилось. Нажми «Обновить материал»."
                          : "Не удалось загрузить страницы текста."}
                      </p>

                      {!changed && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => readPage(pages.page || 1)}
                        >
                          Повторить загрузку страниц
                        </button>
                      )}
                    </div>
                  )}

                  {text && (
                    <>
                      <ol className="material-text-pages">
                        {text.pages.map((page) => (
                          <li
                            className="material-text-page"
                            key={page.pageNumber}
                          >
                            <h4>Страница PDF {page.pageNumber}</h4>

                            {page.text === "" ? (
                              <p className="material-text-hint">
                                На этой странице нет извлечённого текста.
                              </p>
                            ) : (
                              <pre>{page.text}</pre>
                            )}
                          </li>
                        ))}
                      </ol>

                      {text.pages.length === 0 && (
                        <p className="material-text-hint" role="status">
                          На этой странице списка нет текста. Вернись назад.
                        </p>
                      )}

                      <nav
                        className="material-text-pagination"
                        aria-label="Страницы текста PDF"
                      >
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={text.meta.page <= 1}
                          onClick={() => readPage(text.meta.page - 1)}
                        >
                          Назад по тексту
                        </button>

                        <p>
                          Часть {text.meta.page} из {lastPage}
                          {" · "}Страниц PDF: {text.meta.total}
                        </p>

                        <button
                          type="button"
                          className="secondary-button"
                          disabled={text.meta.page >= lastPage}
                          onClick={() => readPage(text.meta.page + 1)}
                        >
                          Вперёд по тексту
                        </button>
                      </nav>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
