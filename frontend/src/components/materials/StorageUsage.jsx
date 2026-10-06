import { useId } from 'react';
import { HardDrive, RefreshCw } from 'lucide-react';

import { formatBytes } from '../../utils/formatBytes.js';
import '../../styles/storageUsage.css';

export default function StorageUsage({
  status = 'loading',
  usage = null,
  onRefresh,
  errorCode = null,
  retrySeconds = 0,
}) {
  const headingId = useId();
  const loading = status === 'loading';
  const ready = status === 'ready' && usage !== null;
  const occupiedBytes = ready ? usage.usedBytes + usage.reservedBytes : 0;
  const availableBytes = ready ? usage.limitBytes - occupiedBytes : 0;
  const usedPercent = ready ? usage.usedBytes / usage.limitBytes * 100 : 0;
  const reservedPercent = ready ? usage.reservedBytes / usage.limitBytes * 100 : 0;

  return (
    <section
      className="panel storage-usage"
      aria-labelledby={headingId}
      aria-busy={loading}
    >
      <div className="storage-usage-heading">
        <div className="storage-usage-title">
          <span className="storage-usage-icon" aria-hidden="true">
            <HardDrive size={23} />
          </span>

          <div>
            <h3 id={headingId}>Хранилище аккаунта</h3>
            <p>Общее для всех твоих предметов</p>
          </div>
        </div>

        {onRefresh && (
          <button
            type="button"
            className="secondary-button"
            disabled={loading || retrySeconds > 0}
            onClick={onRefresh}
            aria-label="Обновить сведения о хранилище"
          >
            <RefreshCw size={16} aria-hidden="true" />
            Обновить
          </button>
        )}
      </div>

      {loading ? (
        <p className="storage-usage-message" role="status">
          Проверяем свободное место…
        </p>
      ) : !ready ? (
        <p className="form-error" role="alert">
          {errorCode === 'RATE_LIMITED'
            ? 'Слишком много запросов. Подожди перед повтором.'
            : 'Не удалось получить сведения о хранилище. Попробуй обновить их.'}
        </p>
      ) : (
        <>
          <div
            className="storage-usage-meter"
            role="meter"
            aria-label="Занятое и зарезервированное место"
            aria-valuemin={0}
            aria-valuemax={usage.limitBytes}
            aria-valuenow={occupiedBytes}
            aria-valuetext={
              'Занято ' + formatBytes(usage.usedBytes)
              + ', в резерве ' + formatBytes(usage.reservedBytes)
              + ', доступно ' + formatBytes(availableBytes)
              + '. Общий лимит ' + formatBytes(usage.limitBytes)
            }
          >
            <span
              className="storage-usage-meter-used"
              style={{ width: usedPercent + '%' }}
              aria-hidden="true"
            />
            <span
              className="storage-usage-meter-reserved"
              style={{ width: reservedPercent + '%' }}
              aria-hidden="true"
            />
          </div>

          <dl className="storage-usage-stats">
            <div>
              <dt>
                <span className="storage-usage-dot storage-usage-dot-used" />
                Занято
              </dt>
              <dd>{formatBytes(usage.usedBytes)}</dd>
            </div>

            <div>
              <dt>
                <span className="storage-usage-dot storage-usage-dot-reserved" />
                В резерве
              </dt>
              <dd>{formatBytes(usage.reservedBytes)}</dd>
            </div>

            <div>
              <dt>Доступно</dt>
              <dd>{formatBytes(availableBytes)}</dd>
            </div>
          </dl>

          <p className="storage-usage-note">
            Лимит аккаунта: {formatBytes(usage.limitBytes)}.
            Один PDF — до {formatBytes(usage.maxUploadBytes)}.
          </p>

          {usage.reservedBytes > 0 && (
            <p className="storage-usage-note">
              Резерв занят незавершёнными загрузками. После ошибки он может
              освободиться не сразу.
            </p>
          )}

          <p className="storage-usage-note">
            Удаляемые файлы занимают место до завершения удаления.
          </p>

          {availableBytes === 0 && (
            <p className="storage-usage-warning" role="status">
              Свободного места сейчас нет. Дождись завершения текущих операций
              или освободи место.
            </p>
          )}
        </>
      )}
      {retrySeconds > 0 && <p role="status">Повтор доступен через {retrySeconds} с.</p>}
    </section>
  );
}
