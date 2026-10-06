import { useCallback, useEffect, useRef, useState } from 'react';
import { retryDeadline, retrySeconds } from '../services/retryAfter.js';

// Таймер только обновляет сообщение и кнопки. Повтор запроса всегда явный.
export function useRetryCooldown({ initialRetryAt = 0, onChange } = {}) {
  const deadlineRef = useRef(initialRetryAt);
  const [retryAt, setRetryAt] = useState(initialRetryAt);
  const [seconds, setSeconds] = useState(() => retrySeconds(initialRetryAt));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const remember = useCallback((error) => {
    const deadline = Math.max(deadlineRef.current, retryDeadline(error));
    deadlineRef.current = deadline;
    setRetryAt(deadline);
    setSeconds(retrySeconds(deadline));
    onChangeRef.current?.(deadline);
  }, []);

  useEffect(() => {
    const update = () => setSeconds(retrySeconds(retryAt));
    update();
    if (retrySeconds(retryAt) === 0) return undefined;
    const timer = setInterval(() => {
      update();
      if (retrySeconds(retryAt) === 0) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [retryAt]);

  const isBlocked = useCallback(() => retrySeconds(deadlineRef.current) > 0, []);
  return { retryAt, seconds, blocked: seconds > 0, remember, isBlocked };
}

export default useRetryCooldown;
