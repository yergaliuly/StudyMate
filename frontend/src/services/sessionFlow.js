import { ApiError } from './apiClient.js';
import { authApi } from './authApi.js';

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

  async function reconcile(options) {
    try {
      return await readSession(options);
    } catch {
      checkCancellation(options?.signal);
      throw new ApiError('Не удалось подтвердить состояние сессии.', {
        code: 'SESSION_CHECK_FAILED',
      });
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
    } catch {
      checkCancellation(options.signal);
      // Даже при ошибке POST состояние определяет только свежий /me.
    }
    return reconcile(options);
  }

  return { readSession, signIn, signOut };
}

export const sessionFlow = createSessionFlow();
