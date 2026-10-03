const DEFAULT_BASE_URL = import.meta.env?.VITE_API_BASE_URL || '/api/v1';
const API_PATH = /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/;

export class ApiError extends Error {
  constructor(message, {
    status = 0,
    code = 'REQUEST_FAILED',
    fieldErrors = {},
    retryAfterSeconds = null,
  } = {}) {
    super(message);

    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function readRetryAfter(response) {
  const value = response.headers.get('Retry-After');

  const seconds = value && /^\d+$/.test(value)
    ? Number(value)
    : NaN;

  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function createApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  // Пока поддерживаем только API на том же origin,
  // в том числе через Vite proxy.
  if (typeof baseUrl !== 'string' || !API_PATH.test(baseUrl)) {
    throw new TypeError(
      'Базовый путь API должен иметь вид /api/v1.',
    );
  }

  const base = baseUrl.replace(/\/$/, '');

  let csrf = null;
  let csrfVersion = 0;
  let csrfRefresh = null;

  function clearCsrf() {
    csrf = null;
    csrfVersion += 1;
  }

  async function request(path, {
    method = 'GET',
    query = {},
    body,
    signal,
    idempotencyKey,
  } = {}) {
    if (typeof path !== 'string' || !API_PATH.test(path)) {
      throw new TypeError(
        'Укажи путь вроде /subjects; параметры передавай в query.',
      );
    }

    const verb = method.toUpperCase();

    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(verb)) {
      throw new TypeError(
        'Этот HTTP-метод пока не поддерживается.',
      );
    }

    if (verb === 'GET' && body !== undefined) {
      throw new TypeError(
        'GET-запрос не должен содержать body.',
      );
    }

    if (signal?.aborted) {
      throw new ApiError('Запрос отменён.', {
        code: 'REQUEST_CANCELLED',
      });
    }

    const headers = new Headers({
      Accept: 'application/json',
    });

    if (verb !== 'GET') {
      if (!csrf) {
        throw new ApiError(
          'Сначала требуется получить CSRF-токен.',
          { code: 'CSRF_NOT_INITIALIZED' },
        );
      }

      headers.set(csrf.headerName, csrf.token);
    }

    if (idempotencyKey !== undefined) {
      // Ключ создаёт вызывающий код для одной логической операции.
      headers.set('Idempotency-Key', idempotencyKey);
    }

    let requestBody;

    if (body !== undefined) {
      if (body instanceof FormData) {
        // Content-Type с multipart boundary установит браузер.
        requestBody = body;
      } else {
        headers.set('Content-Type', 'application/json');
        requestBody = JSON.stringify(body);
      }
    }

    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }

    const suffix = params.size > 0 ? `?${params}` : '';
    const versionAtStart = csrfVersion;

    let response;

    try {
      response = await fetchImpl(`${base}${path}${suffix}`, {
        method: verb,
        headers,
        body: requestBody,
        credentials: 'include',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
      });

      if (response.status === 204) {
        return {
          data: null,
          meta: null,
          status: 204,
        };
      }

      const text = await response.text();
      let payload = null;

      try {
        payload = JSON.parse(text);
      } catch {
        // Не показываем пользователю сырую HTML-страницу
        // или ответ прокси.
      }

      if (!response.ok) {
        const details = isRecord(payload?.error)
          ? payload.error
          : {};

        const code = typeof details.code === 'string'
          ? details.code
          : 'HTTP_ERROR';

        if (
          response.status === 403 &&
          code === 'CSRF_INVALID' &&
          versionAtStart === csrfVersion
        ) {
          clearCsrf();
        }

        const fieldErrors = isRecord(details.fieldErrors)
          ? Object.fromEntries(
              Object.entries(details.fieldErrors).filter(
                ([, value]) => typeof value === 'string',
              ),
            )
          : {};

        throw new ApiError(
          typeof details.message === 'string' &&
          details.message.trim()
            ? details.message
            : `Сервер вернул ошибку HTTP ${response.status}.`,
          {
            status: response.status,
            code,
            fieldErrors,
            retryAfterSeconds: readRetryAfter(response),
          },
        );
      }

      if (
        !isRecord(payload) ||
        !Object.hasOwn(payload, 'data')
      ) {
        throw new ApiError(
          'Ответ сервера не соответствует контракту API.',
          {
            status: response.status,
            code: 'INVALID_RESPONSE',
          },
        );
      }

      return {
        data: payload.data,
        meta: payload.meta ?? null,
        status: response.status,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (
        signal?.aborted ||
        error?.name === 'AbortError'
      ) {
        throw new ApiError('Запрос отменён.', {
          code: 'REQUEST_CANCELLED',
        });
      }

      throw new ApiError(
        'Не удалось получить ответ сервера. Результат операции может быть неизвестен.',
        {
          status: response?.status ?? 0,
          code: 'NETWORK_ERROR',
        },
      );
    }
  }

  function checkCsrfVersion(version) {
    if (version !== csrfVersion) {
      throw new ApiError(
        'Результат обновления CSRF уже не актуален.',
        { code: 'CSRF_REFRESH_SUPERSEDED' },
      );
    }
  }

  async function loadCsrf(version, previous) {
    // A superseded GET can still set a cookie. Drain its response before a
    // replacement GET, even when the earlier caller has stopped waiting.
    if (previous) await previous.catch(() => {});
    checkCsrfVersion(version);

    // A caller's abort must not interrupt the shared cookie-establishing request.
    const { data } = await request('/auth/csrf');
    checkCsrfVersion(version);

    if (
      !isRecord(data) ||
      typeof data.headerName !== 'string' ||
      data.headerName.toUpperCase() !== 'X-CSRF-TOKEN' ||
      typeof data.token !== 'string' ||
      !data.token.trim() ||
      /[\r\n]/.test(data.token)
    ) {
      throw new ApiError(
        'Сервер вернул некорректные данные CSRF.',
        { code: 'INVALID_RESPONSE' },
      );
    }

    csrf = {
      headerName: data.headerName,
      token: data.token,
    };
  }

  async function refreshCsrf({ signal } = {}) {
    if (signal?.aborted) {
      throw new ApiError('Запрос отменён.', { code: 'REQUEST_CANCELLED' });
    }

    if (!csrfRefresh || csrfRefresh.version !== csrfVersion) {
      const previous = csrfRefresh?.promise;
      clearCsrf();
      const flight = { version: csrfVersion, promise: null };
      csrfRefresh = flight;
      flight.promise = loadCsrf(flight.version, previous).finally(() => {
        if (csrfRefresh === flight) csrfRefresh = null;
      });
    }

    const pending = csrfRefresh.promise;
    if (!signal) return pending;

    // Cancel this caller promptly without cancelling other callers or starting
    // another anonymous session (including React StrictMode's second effect).
    return new Promise((resolve, reject) => {
      const finish = (complete, value) => {
        signal.removeEventListener('abort', cancel);
        complete(value);
      };
      const cancel = () => finish(reject,
        new ApiError('Запрос отменён.', { code: 'REQUEST_CANCELLED' }));

      signal.addEventListener('abort', cancel, { once: true });
      pending.then(
        () => { if (signal.aborted) cancel(); else finish(resolve); },
        (error) => { if (signal.aborted) cancel(); else finish(reject, error); },
      );
      if (signal.aborted) cancel();
    });
  }

  return {
    request,
    refreshCsrf,
    clearCsrf,
  };
}

// Создание клиента само по себе не отправляет запросы.
export const apiClient = createApiClient();
