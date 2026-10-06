import test from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, retryDeadline, retrySeconds } from '../src/services/retryAfter.js';

test('Retry-After задаёт секунды до следующего ручного запроса, включая частичную последнюю секунду', () => {
  const deadline = retryDeadline({ status: 429, retryAfterSeconds: 12 }, 1000);
  assert.equal(deadline, 13000);
  assert.equal(retrySeconds(deadline, 1001), 12);
  assert.equal(retrySeconds(deadline, 12999), 1);
  assert.equal(retrySeconds(deadline, 13000), 0);
  assert.equal(retrySeconds(deadline, 99999), 0);
});

test('Другие ошибки и некорректные значения не создают cooldown', () => {
  assert.equal(retryDeadline({ status: 503, retryAfterSeconds: 12 }, 1000), 0);
  for (const retryAfterSeconds of [null, undefined, -1, 0, 1.5, Infinity, NaN, '12', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(retryDeadline({ code: 'RATE_LIMITED', retryAfterSeconds }, 1000), 0);
  }
});

test('Сохраняется распознавание HTTP 429 после обёртки ошибки сессии; большой срок не переполняет таймер', () => {
  assert.equal(isRateLimited({ code: 'SESSION_CHECK_FAILED', status: 429 }), true);
  assert.equal(isRateLimited({ code: 'RATE_LIMITED' }), true);
  assert.equal(isRateLimited(null), false);
  assert.equal(retryDeadline({ status: 429, retryAfterSeconds: Number.MAX_SAFE_INTEGER }, 1000), Number.MAX_SAFE_INTEGER);
});
