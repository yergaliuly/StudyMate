export function isRateLimited(error) {
  return error?.status === 429 || error?.code === 'RATE_LIMITED';
}

export function retryDeadline(error, now = Date.now()) {
  const seconds = error?.retryAfterSeconds;
  if (!isRateLimited(error) || !Number.isSafeInteger(seconds) || seconds <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, now + seconds * 1000);
}

export function retrySeconds(retryAt, now = Date.now()) {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}
