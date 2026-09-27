import { apiClient, ApiError } from './apiClient.js';

function requireString(values, field) {
  if (typeof values?.[field] !== 'string') {
    throw new TypeError(`Поле ${field} должно быть строкой.`);
  }

  return values[field];
}

function invalidResponse(status) {
  return new ApiError(
    'Ответ сервера не соответствует контракту аккаунта.',
    { status, code: 'INVALID_RESPONSE' },
  );
}

function readUser(result, expectedStatus) {
  const user = result.data;

  if (
    result.status !== expectedStatus ||
    user === null ||
    typeof user !== 'object' ||
    Array.isArray(user) ||
    !['id', 'email', 'displayName'].every(
      (field) =>
        typeof user[field] === 'string' &&
        user[field].trim().length > 0,
    )
  ) {
    throw invalidResponse(result.status);
  }

  // Возвращаем только поля публичной модели User.
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}

export function createAuthApi(client = apiClient) {
  function refreshCsrf(options = {}) {
    return client.refreshCsrf(options);
  }

  async function getCurrentUser({ signal } = {}) {
    try {
      const result = await client.request('/auth/me', { signal });
      return readUser(result, 200);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        error.code === 'AUTHENTICATION_REQUIRED'
      ) {
        return null;
      }

      // Ошибка сети или сервера не означает "гость".
      throw error;
    }
  }

  async function register(values, { signal } = {}) {
    const body = {
      email: requireString(values, 'email').trim(),
      password: requireString(values, 'password'),
      displayName: requireString(values, 'displayName').trim(),
    };

    const result = await client.request('/auth/register', {
      method: 'POST',
      body,
      signal,
    });

    // Возвращённый User не означает выполненный вход.
    return readUser(result, 201);
  }

  async function sessionRequest(path, options) {
    try {
      const result = await client.request(path, options);

      // После смены сессии прежний CSRF не используем.
      // Получение нового токена — отдельный следующий шаг.
      client.clearCsrf();

      return result;
    } catch (error) {
      if (
        error instanceof ApiError &&
        ['NETWORK_ERROR', 'REQUEST_CANCELLED', 'INVALID_RESPONSE']
          .includes(error.code)
      ) {
        // При неоднозначном результате токен мог устареть.
        // Это НЕ означает, что вход или выход точно состоялся.
        client.clearCsrf();
      }

      throw error;
    }
  }

  async function login(values, { signal } = {}) {
    const body = {
      email: requireString(values, 'email').trim(),
      password: requireString(values, 'password'),
    };

    const result = await sessionRequest('/auth/login', {
      method: 'POST',
      body,
      signal,
    });

    return readUser(result, 200);
  }

  async function logout({ signal } = {}) {
    const result = await sessionRequest('/auth/logout', {
      method: 'POST',
      signal,
    });

    if (result.status !== 204) {
      throw invalidResponse(result.status);
    }
  }

  return {
    refreshCsrf,
    getCurrentUser,
    register,
    login,
    logout,
  };
}

// Импорт модуля сам по себе не отправляет запросы.
export const authApi = createAuthApi();