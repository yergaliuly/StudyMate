import { attemptApi } from './attemptApi.js';
import { materialApi } from './materialApi.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 20;
const sameId = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const invalidResponse = () => ({ status: 200, code: 'INVALID_RESPONSE' });
const accessError = (error) => (error?.status === 401 && error.code === 'AUTHENTICATION_REQUIRED')
  || (error?.status === 403 && error.code === 'CSRF_INVALID') || error?.code === 'CSRF_NOT_INITIALIZED';
const unavailableError = (error) => error?.status === 404
  || (error?.status === 409 && error.code === 'MATERIAL_NOT_AVAILABLE');

function info(value) {
  return {
    id: value.id, quizId: value.quizId, materialId: value.materialId, quizVersion: value.quizVersion,
    status: value.status, questionCount: value.questionCount, startedAt: value.startedAt,
    completedAt: value.completedAt, correctCount: value.correctCount, scorePercent: value.scorePercent,
  };
}

function copyQuestions(questions) {
  return questions.map(({ id, position, text, options }) => ({
    id, position, text,
    options: options.map(({ id: optionId, position: optionPosition, text: optionText }) => ({
      id: optionId, position: optionPosition, text: optionText,
    })),
  }));
}

function copyAttempt(value) {
  return {
    ...info(value), questions: copyQuestions(value.questions),
    review: value.status === 'completed' ? value.review.map((item) => ({
      questionId: item.questionId, selectedOptionId: item.selectedOptionId,
      correctOptionId: item.correctOptionId, isCorrect: item.isCorrect,
      explanation: item.explanation, sourcePages: [...item.sourcePages],
    })) : null,
  };
}

function copyDetail(detail) {
  return detail ? {
    attempt: copyAttempt(detail.attempt), material: { ...detail.material },
    quiz: { ...detail.quiz, questions: copyQuestions(detail.quiz.questions) },
  } : null;
}

function emptyView(page) {
  return {
    phase: 'loading', attempts: [], meta: { page, pageSize: PAGE_SIZE, total: 0 },
    reading: false, namesLoading: false, namesError: false, listStale: true, message: '',
    detail: null, detailPhase: 'idle', detailMessage: '',
  };
}

function entry(record) {
  if (!record || typeof record !== 'object') throw new TypeError('Нужна запись истории аккаунта.');
  record.attemptHistory ??= {
    page: 1, filters: {}, selectedAttemptId: null, selectedInfo: null,
    retryAt: 0, detailRetryAt: 0, listOperation: null, detailOperation: null,
    view: emptyView(1),
  };
  return record.attemptHistory;
}

function snapshot(draft) {
  return {
    ...draft.view,
    attempts: draft.view.attempts.map((value) => ({ ...info(value), materialTitle: value.materialTitle, materialStatus: value.materialStatus })),
    meta: { ...draft.view.meta }, filters: { ...draft.filters }, detail: copyDetail(draft.view.detail),
    selectedAttemptId: draft.selectedAttemptId, retryAt: draft.retryAt, detailRetryAt: draft.detailRetryAt,
  };
}

export function getAttemptHistoryState(record) {
  return snapshot(entry(record));
}

function normalizedFilters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['status', 'materialId', 'quizId'].includes(key))) return null;
  const filters = {};
  if (value.status !== undefined && value.status !== '') {
    if (!['in_progress', 'completed'].includes(value.status)) return null;
    filters.status = value.status;
  }
  for (const key of ['materialId', 'quizId']) {
    if (value[key] !== undefined && value[key] !== '') {
      if (typeof value[key] !== 'string' || !UUID.test(value[key])) return null;
      filters[key] = value[key].toLowerCase();
    }
  }
  return filters;
}

export function createAttemptHistoryController({
  record, canAct, onChange, onAccessError, onAccessRestored = () => {},
  api = attemptApi, materials = materialApi, now = Date.now,
}) {
  const draft = entry(record);
  let stopped = false;
  let listRequest = null;
  let detailRequest = null;
  let listEpoch = 0;
  let detailEpoch = 0;
  let queuedRefresh = null;
  const owns = () => record.attemptHistory === draft;
  const active = () => !stopped && owns() && canAct();
  const waiting = () => now() < draft.retryAt;

  function publish(changes = {}, persistent = {}) {
    if (!active()) return;
    Object.assign(draft, persistent);
    Object.assign(draft.view, changes);
    onChange(snapshot(draft));
  }

  function cancelList() {
    const previous = listRequest;
    listRequest = null;
    listEpoch += 1;
    queuedRefresh = null;
    if (owns() && draft.listOperation === previous) draft.listOperation = null;
    previous?.controller.abort();
  }

  function cancelDetail() {
    const previous = detailRequest;
    detailRequest = null;
    detailEpoch += 1;
    if (owns() && draft.detailOperation === previous) draft.detailOperation = null;
    previous?.controller.abort();
  }

  function retryAt(error) {
    const seconds = Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds : 0;
    return Math.min(Number.MAX_SAFE_INTEGER, now() + seconds * 1000);
  }

  function sessionFailure(error) {
    if (!active()) return;
    stop();
    onAccessError(error);
  }

  function markMaterial(materialId, title, status) {
    publish({ attempts: draft.view.attempts.map((row) => sameId(row.materialId, materialId)
      ? { ...row, materialTitle: title, materialStatus: status } : row) });
  }

  function unavailableMaterial(materialId, closeSelection) {
    if (!active()) return;
    if (sameId(draft.selectedInfo?.materialId, materialId)) {
      cancelDetail();
      publish({ detail: null, detailPhase: closeSelection ? 'idle' : 'unavailable',
        detailMessage: closeSelection ? '' : 'Материал этой попытки больше недоступен.' },
      closeSelection ? { selectedAttemptId: null, selectedInfo: null } : {});
    }
    if (active()) markMaterial(materialId, 'Материал недоступен', 'unavailable');
  }

  function validMaterial(value, materialId) {
    return sameId(value?.id, materialId) && typeof value.subjectId === 'string' && UUID.test(value.subjectId)
      && typeof value.title === 'string' && value.title.trim().length > 0;
  }

  function validInfo(value) {
    return ['id', 'quizId', 'materialId'].every((key) => typeof value?.[key] === 'string' && UUID.test(value[key]))
      && Number.isSafeInteger(value.quizVersion) && value.quizVersion > 0 && value.questionCount === 10
      && ['in_progress', 'completed'].includes(value.status);
  }

  function matchesFilters(value) {
    return (!draft.filters.status || value.status === draft.filters.status)
      && (!draft.filters.materialId || sameId(value.materialId, draft.filters.materialId))
      && (!draft.filters.quizId || sameId(value.quizId, draft.filters.quizId));
  }

  function matchesSelected(value, expected) {
    return validInfo(value) && sameId(value.id, expected.id) && sameId(value.quizId, expected.quizId)
      && sameId(value.materialId, expected.materialId) && value.quizVersion === expected.quizVersion
      && value.startedAt === expected.startedAt
      && (expected.status !== 'completed' || (value.status === 'completed'
        && value.completedAt === expected.completedAt && value.correctCount === expected.correctCount
        && value.scorePercent === expected.scorePercent));
  }

  async function readNames(operation, current) {
    const ids = [...new Map(draft.view.attempts.map((row) => [row.materialId.toLowerCase(), row.materialId])).values()];
    let next = 0;
    async function worker() {
      while (current() && !waiting() && next < ids.length) {
        const id = ids[next++];
        try {
          const value = await materials.getById(id, { signal: operation.controller.signal });
          if (!current()) return;
          if (!validMaterial(value, id)) throw invalidResponse();
          if (value.status !== 'stored') unavailableMaterial(id, true);
          else markMaterial(id, value.title, 'ready');
        } catch (error) {
          if (!current()) return;
          if (accessError(error)) { sessionFailure(error); return; }
          if (unavailableError(error)) unavailableMaterial(id, true);
          else {
            markMaterial(id, 'Материал', 'error');
            if (current()) publish({ namesError: true }, { retryAt: Math.max(draft.retryAt, retryAt(error)) });
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, () => worker()));
    if (!current()) return;
    publish({ namesLoading: false, attempts: draft.view.attempts.map((row) => row.materialStatus === 'loading'
      ? { ...row, materialStatus: 'error' } : row),
    namesError: draft.view.namesError || draft.view.attempts.some((row) => row.materialStatus === 'loading') });
  }

  async function refresh({ preserveDetail = false } = {}) {
    if (!active() || (draft.listOperation && draft.listOperation !== listRequest)) return;
    if (draft.view.reading) {
      if (preserveDetail && listRequest) queuedRefresh = listRequest.epoch;
      return;
    }
    if (waiting()) { publish(); return; }
    if (listRequest) cancelList();
    if (!preserveDetail) {
      cancelDetail();
      publish({ detail: null, detailPhase: draft.selectedAttemptId ? 'loading' : 'idle', detailMessage: '' });
      if (!active()) return;
    }
    const selectionAtStart = detailEpoch;
    const operation = { controller: new AbortController(), epoch: ++listEpoch };
    listRequest = operation;
    draft.listOperation = operation;
    const current = () => active() && listRequest === operation && draft.listOperation === operation
      && operation.epoch === listEpoch && !operation.controller.signal.aborted;
    publish({ phase: 'loading', reading: true, namesLoading: false, namesError: false, message: '' });
    try {
      if (!current()) return;
      let page = draft.page;
      let result;
      for (let pass = 0; pass < 2; pass += 1) {
        result = await api.list({ ...draft.filters, page, pageSize: PAGE_SIZE, signal: operation.controller.signal });
        if (!current()) return;
        if (!Array.isArray(result?.attempts) || result.meta?.page !== page || result.meta.pageSize !== PAGE_SIZE
          || !Number.isSafeInteger(result.meta.total) || result.meta.total < 0
          || result.attempts.some((row) => !validInfo(row) || !matchesFilters(row))) throw invalidResponse();
        const lastPage = Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE));
        if (page <= lastPage) break;
        if (pass || result.attempts.length !== 0) throw invalidResponse();
        page = lastPage;
      }
      onAccessRestored();
      if (!current()) return;
      const selected = result.attempts.find((row) => sameId(row.id, draft.selectedAttemptId));
      if (selected && draft.selectedInfo && !matchesSelected(selected, draft.selectedInfo)) throw invalidResponse();
      publish({
        phase: 'ready', attempts: result.attempts.map((row) => ({ ...info(row), materialTitle: 'Материал', materialStatus: 'loading' })),
        meta: { page, pageSize: PAGE_SIZE, total: result.meta.total }, reading: false,
        listStale: false, namesLoading: result.attempts.length > 0,
      }, { page, ...(selected ? { selectedInfo: info(selected) } : {}) });
      if (!current()) return;
      if (!preserveDetail && draft.selectedAttemptId && detailEpoch === selectionAtStart) void openAttempt(draft.selectedAttemptId);
      await readNames(operation, current);
    } catch (error) {
      if (!current()) return;
      if (accessError(error)) { sessionFailure(error); return; }
      publish({ phase: 'error', reading: false, namesLoading: false, listStale: true,
        message: error?.status === 429 ? 'Слишком много запросов. Подожди перед обновлением истории.'
          : 'Не удалось получить историю попыток. Попробуй обновить её.',
        ...(!preserveDetail ? { detail: null, detailPhase: draft.selectedAttemptId ? 'error' : 'idle',
          detailMessage: draft.selectedAttemptId ? 'Сначала обнови историю, затем открой попытку.' : '' } : {}),
      }, { retryAt: retryAt(error) });
    } finally {
      if (current()) {
        const again = queuedRefresh === operation.epoch;
        queuedRefresh = null;
        listRequest = null;
        draft.listOperation = null;
        if (again && active()) {
          if (waiting()) publish({ listStale: true });
          else await refresh({ preserveDetail: true });
        }
      }
    }
  }

  async function changePage(page) {
    if (!active() || !Number.isSafeInteger(page) || page < 1 || waiting()) return;
    cancelList();
    draft.page = page;
    await refresh({ preserveDetail: true });
  }

  async function setFilters(value) {
    if (!active()) return;
    const filters = normalizedFilters(value);
    if (!filters) return;
    if (JSON.stringify(filters) === JSON.stringify(draft.filters)) return;
    cancelList();
    cancelDetail();
    publish({ ...emptyView(1) }, { page: 1, filters, selectedAttemptId: null, selectedInfo: null });
    if (active()) await refresh();
  }

  async function openAttempt(attemptId) {
    if (!active() || typeof attemptId !== 'string' || !UUID.test(attemptId)) return;
    const row = draft.view.attempts.find((value) => sameId(value.id, attemptId));
    const previous = sameId(draft.selectedAttemptId, attemptId) ? draft.selectedInfo : null;
    const expected = previous?.status === 'completed' ? previous : row ?? previous;
    if (!expected) return;
    cancelDetail();
    publish({ detail: null, detailPhase: 'loading', detailMessage: '' }, { selectedAttemptId: expected.id, selectedInfo: info(expected) });
    if (!active()) return;
    if (row?.materialStatus === 'unavailable') {
      publish({ detailPhase: 'unavailable', detailMessage: 'Материал этой попытки больше недоступен.' });
      return;
    }
    if (now() < draft.detailRetryAt) {
      publish({ detailPhase: 'error', detailMessage: 'Подожди перед повторным открытием попытки.' });
      return;
    }
    const operation = { controller: new AbortController(), epoch: detailEpoch };
    detailRequest = operation;
    draft.detailOperation = operation;
    const current = () => active() && detailRequest === operation && draft.detailOperation === operation
      && detailEpoch === operation.epoch && sameId(draft.selectedAttemptId, expected.id)
      && !operation.controller.signal.aborted;
    try {
      if (!current()) return;
      const value = await api.getById(expected.id, { signal: operation.controller.signal });
      if (!current()) return;
      if (!matchesSelected(value, expected) || !matchesSelected(value, draft.selectedInfo)
        || !Array.isArray(value.questions) || value.questions.length !== 10
        || value.questions.some((question) => !Array.isArray(question.options) || question.options.length !== 4)
        || (value.status === 'completed' && (!Array.isArray(value.review) || value.review.length !== 10))) throw invalidResponse();
      const material = await materials.getById(value.materialId, { signal: operation.controller.signal });
      if (!current()) return;
      if (!matchesSelected(value, draft.selectedInfo)) throw invalidResponse();
      if (!validMaterial(material, value.materialId)) throw invalidResponse();
      if (material.status !== 'stored') {
        unavailableMaterial(value.materialId, false);
        return;
      }
      onAccessRestored();
      if (!current()) return;
      const attempt = copyAttempt(value);
      publish({ detailPhase: 'ready', detailMessage: '', detail: {
        attempt, material: { id: material.id, subjectId: material.subjectId, title: material.title, status: material.status },
        quiz: { id: value.quizId, materialId: value.materialId, version: value.quizVersion,
          questionCount: value.questionCount, questions: copyQuestions(value.questions) },
      } }, { selectedInfo: info(value), detailRetryAt: 0 });
    } catch (error) {
      if (!current()) return;
      if (accessError(error)) { sessionFailure(error); return; }
      publish({ detail: null, detailPhase: unavailableError(error) ? 'unavailable' : 'error',
        detailMessage: unavailableError(error) ? 'Эта попытка или её материал больше недоступны.'
          : error?.status === 429 ? 'Слишком много запросов. Подожди перед повторным открытием.'
            : 'Не удалось открыть попытку. Попробуй ещё раз.',
      }, { detailRetryAt: retryAt(error) });
    } finally {
      if (current()) { detailRequest = null; draft.detailOperation = null; }
    }
  }

  function closeAttempt() {
    if (!active()) return;
    cancelDetail();
    publish({ detail: null, detailPhase: 'idle', detailMessage: '' }, { selectedAttemptId: null, selectedInfo: null });
  }

  function stop() {
    if (stopped) return;
    if (owns()) draft.view = emptyView(draft.page);
    stopped = true;
    cancelList();
    cancelDetail();
  }

  return { refresh, changePage, setFilters, openAttempt, closeAttempt, stop };
}
