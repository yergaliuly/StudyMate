import { useEffect, useState } from 'react';
import { FileText, ArrowRight } from 'lucide-react';

import { formatFileSize } from '../../services/pdfFiles.js';

export default function LectureCard({ lecture }) {
  const [previewUrl, setPreviewUrl] = useState('');

  const file = lecture.source === 'local' ? lecture.file : null;
  const isLocal = file !== null;

  useEffect(() => {
    if (!file) {
      return;
    }

    const pdfBlob = new Blob([file], {
      type: 'application/pdf',
    });

    const url = URL.createObjectURL(pdfBlob);

    setPreviewUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  return (
    <article className="panel lecture-card">
      <div className="lecture-card-top">
        <span className="icon-tile tone-blue">
          <FileText size={23} aria-hidden="true" />
        </span>

        <span
          className={
            isLocal
              ? 'demo-badge local-file-badge'
              : 'demo-badge'
          }
        >
          {isLocal ? 'Не отправлено' : 'Пример'}
        </span>
      </div>

      <h3>{lecture.title}</h3>

      <p className="lecture-description">
        {isLocal
          ? `${file.name} · ${formatFileSize(file.size)}`
          : lecture.description}
      </p>

      <div className="lecture-card-footer">
        <span>
          {isLocal ? 'Локальный PDF' : 'Демонстрационная карточка'}
        </span>

        {isLocal && previewUrl ? (
          <a
            className="secondary-button"
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Открыть PDF «${lecture.title}» в новой вкладке`}
          >
            Открыть PDF
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        ) : (
          <button
            type="button"
            className="secondary-button"
            disabled
          >
            Открыть
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      <p className="lecture-card-note">
        {isLocal
          ? 'Файл выбран на этом устройстве. В облако не отправлен.'
          : 'Это пример оформления. Настоящий PDF не прикреплён.'}
      </p>
    </article>
  );
}