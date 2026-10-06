import { ApiError } from './apiClient.js';
import { authApi } from './authApi.js';
import { isRateLimited } from './retryAfter.js';

export const LOGIN_NOT_CONFIRMED = 'Вход не подтверждён. Проверь данные и попробуй снова.';
export const LOGOUT_NOT_CONFIRMED = 'Выход не подтверждён. Сессия ещё активна. Попробуй выйти снова.';
export const LOGGED_OUT = 'Вы вышли из аккаунта.';

function checkCancellation(signal) {
  if (signal?.aborted) {
    throw new ApiError('Запрос отменён.', { code: 'REQUEST_CANCELLED' });
  }
}

export function createSessionFlow(api = authApi) {
  async function readSession({ signal } = {}) {
    checkCancellation(signal);
    await api.refreshCsrf({ signal });
    checkCancellation(signal);
    const user = await api.getCurrentUser({ signal });
    checkCancellation(signal);
    return user;
  }

  async function recoverSession({ signal } = {}) {
    checkCancellation(signal);
    // После CSRF_INVALID сначала выясняем, жива ли сессия. Ошибка /me не равна гостю.
    const user = await api.getCurrentUser({ signal });
    checkCancellation(signal);
    // Гостю тоже нужен токен для следующего явного входа или регистрации.
    await api.refreshCsrf({ signal });
    checkCancellation(signal);
    return user;
  }

  function sessionCheckError(error) {
    return new ApiError('Не удалось подтвердить состояние сессии.', {
      code: 'SESSION_CHECK_FAILED',
      status: error?.status,
      retryAfterSeconds: error?.retryAfterSeconds,
    });
  }

  async function reconcile(options, read = readSession) {
    try {
      return await read(options);
    } catch (error) {
      checkCancellation(options?.signal);
      throw sessionCheckError(error);
    }
  }

  async function signIn(values, options = {}) {
    checkCancellation(options.signal);
    try {
      await api.login(values, options);
    } catch (error) {
      checkCancellation(options.signal);
      const uncertain = ['NETWORK_ERROR', 'INVALID_RESPONSE', 'REQUEST_CANCELLED']
        .includes(error?.code) || error?.status >= 500;
      if (!uncertain) {
        throw error;
      }
      // Сервер мог создать сессию. Проверяем её, не повторяя POST.
    }
    return reconcile(options);
  }

  async function signOut(options = {}) {
    checkCancellation(options.signal);
    try {
      await api.logout(options);
    } catch (error) {
      checkCancellation(options.signal);
      if (isRateLimited(error)) throw sessionCheckError(error);
      if (['CSRF_INVALID', 'CSRF_NOT_INITIALIZED'].includes(error?.code)) {
        return reconcile(options, recoverSession);
      }
      // Даже при ошибке POST состояние определяет только свежий /me.
    }
    return reconcile(options);
  }

  return { readSession, recoverSession, signIn, signOut };
}

export const sessionFlow = createSessionFlow();
