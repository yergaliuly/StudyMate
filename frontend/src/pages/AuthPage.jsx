import { useEffect, useRef, useState } from 'react';

import {
  GraduationCap,
  BookOpen,
  FileText,
  Sparkles,
  ArrowRight,
  Eye,
  EyeOff,
} from 'lucide-react';

import { validateAuthForm } from '../services/authValidation.js';

export default function AuthPage({
  mode,
  onModeChange,
  onOpenDemo,
}) {
  const isRegister = mode === 'register';

  const formRef = useRef(null);
  const headingRef = useRef(null);

  const [values, setValues] = useState({
    displayName: '',
    email: '',
    password: '',
  });

  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const fields = [
    ...(isRegister
      ? [
          {
            name: 'displayName',
            label: 'Имя',
            type: 'text',
            autoComplete: 'nickname',
            placeholder: 'Как к тебе обращаться?',
          },
        ]
      : []),

    {
      name: 'email',
      label: 'Email',
      type: 'email',
      autoComplete: 'username',
      placeholder: 'student@example.com',
    },

    {
      name: 'password',
      label: 'Пароль',
      type: showPassword ? 'text' : 'password',
      autoComplete: isRegister
        ? 'new-password'
        : 'current-password',
      placeholder: isRegister
        ? 'Не менее 12 символов'
        : 'Твой пароль',
    },
  ];

  function updateField(name, value) {
    setValues((current) => ({
      ...current,
      [name]: value,
    }));

    setErrors((current) => ({
      ...current,
      [name]: '',
    }));

    setMessage('');
  }

  function handleSubmit(event) {
    event.preventDefault();
    setMessage('');

    const nextErrors = validateAuthForm(values, mode);

    setErrors(nextErrors);

    const firstError = Object.keys(nextErrors)[0];

    if (firstError) {
      formRef.current
        ?.elements.namedItem(firstError)
        ?.focus();

      return;
    }

    // Здесь позже будет await запроса к API.
    // Сейчас не создаём пользователя и не имитируем вход.
    setMessage(
      isRegister
        ? 'Поля проверены. Регистрация ещё не подключена — аккаунт не создан.'
        : 'Поля проверены. Вход ещё не подключён — сессия не создана.',
    );
  }

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <aside className="auth-story">
          <div className="auth-brand">
            <GraduationCap size={33} aria-hidden="true" />

            <span>
              Study<span>Mate</span>
            </span>
          </div>

          <div className="auth-story-copy">
            <p className="auth-eyebrow">
              ТВОЁ УЧЕБНОЕ ПРОСТРАНСТВО
            </p>

            <h2>
              Понимай больше.
              <br />
              Учись спокойнее.
            </h2>

            <p>
              Собери предметы и лекции в одном месте.
              Двигайся к большим целям маленькими шагами.
            </p>
          </div>

          <div className="auth-preview" aria-hidden="true">
            <div className="auth-preview-heading">
              <Sparkles size={20} />
              <strong>Моё пространство</strong>
            </div>

            <div className="auth-preview-row">
              <span className="icon-tile tone-blue">
                <BookOpen size={22} />
              </span>

              <div>
                <strong>Любимые предметы</strong>
                <p>Всё по своим полочкам</p>
              </div>
            </div>

            <div className="auth-preview-row">
              <span className="icon-tile tone-purple">
                <FileText size={22} />
              </span>

              <div>
                <strong>Учебные материалы</strong>
                <p>Больше порядка в лекциях</p>
              </div>
            </div>
          </div>

          <p className="auth-story-footer">
            Учись. Понимай. Достигай большего.
          </p>
        </aside>

        <section
          className="auth-panel"
          aria-labelledby="auth-title"
        >
          <span className="demo-badge">
            Предпросмотр форм
          </span>

          <h1
            id="auth-title"
            ref={headingRef}
            tabIndex={-1}
          >
            {isRegister
              ? 'Создать аккаунт'
              : 'С возвращением!'}
          </h1>

          <p className="auth-description">
            {isRegister
              ? 'Подготовим твоё личное учебное пространство.'
              : 'Продолжи путь к новым знаниям.'}
          </p>

          <form
            ref={formRef}
            className="auth-form"
            onSubmit={handleSubmit}
            noValidate
          >
            {fields.map((field) => {
              const errorId = `auth-${field.name}-error`;

              const hintId =
                field.name === 'password'
                  ? 'auth-password-hint'
                  : '';

              const describedBy = [
                errors[field.name] ? errorId : '',
                hintId,
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <div
                  className="auth-field"
                  key={field.name}
                >
                  <label htmlFor={`auth-${field.name}`}>
                    {field.label}
                  </label>

                  <div
                    className={`auth-input-row ${
                      errors[field.name]
                        ? 'auth-input-row--error'
                        : ''
                    }`}
                  >
                    <input
                      id={`auth-${field.name}`}
                      name={field.name}
                      type={field.type}
                      autoComplete={field.autoComplete}
                      autoCapitalize={
                        field.name === 'displayName'
                          ? 'words'
                          : 'none'
                      }
                      spellCheck={false}
                      placeholder={field.placeholder}
                      value={values[field.name]}
                      onChange={(event) =>
                        updateField(
                          field.name,
                          event.target.value,
                        )
                      }
                      aria-invalid={Boolean(
                        errors[field.name],
                      )}
                      aria-describedby={
                        describedBy || undefined
                      }
                      required
                    />

                    {field.name === 'password' && (
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() =>
                          setShowPassword(
                            (current) => !current,
                          )
                        }
                        aria-label={
                          showPassword
                            ? 'Скрыть пароль'
                            : 'Показать пароль'
                        }
                        aria-controls="auth-password"
                      >
                        {showPassword ? (
                          <EyeOff
                            size={19}
                            aria-hidden="true"
                          />
                        ) : (
                          <Eye
                            size={19}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    )}
                  </div>

                  {field.name === 'password' && (
                    <p
                      id={hintId}
                      className="auth-hint"
                    >
                      {isRegister
                        ? 'От 12 до 128 символов. Пробелы в пароле сохраняются.'
                        : 'Введи пароль без изменения пробелов и регистра.'}
                    </p>
                  )}

                  {errors[field.name] && (
                    <p
                      id={errorId}
                      className="auth-error"
                      role="alert"
                    >
                      {errors[field.name]}
                    </p>
                  )}
                </div>
              );
            })}

            {message && (
              <p
                className="auth-feedback"
                role="status"
              >
                {message}
              </p>
            )}

            <button
              type="submit"
              className="primary-button auth-submit"
            >
              {isRegister ? 'Создать аккаунт' : 'Войти'}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>

          <p className="auth-development-note">
            Сейчас проверяются только поля формы.
            Данные не отправляются на сервер, аккаунты
            не создаются. Используй тестовые значения.
          </p>

          <p className="auth-switch">
            {isRegister
              ? 'Уже есть аккаунт?'
              : 'Ещё нет аккаунта?'}{' '}

            <button
              type="button"
              onClick={() =>
                onModeChange(
                  isRegister ? 'login' : 'register',
                )
              }
            >
              {isRegister
                ? 'Войти'
                : 'Зарегистрироваться'}
            </button>
          </p>

          <div className="auth-demo-section">
            <p>
              Посмотреть готовый интерфейс без аккаунта
            </p>

            <button
              type="button"
              className="secondary-button auth-demo-button"
              onClick={onOpenDemo}
            >
              Открыть демо-кабинет
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}