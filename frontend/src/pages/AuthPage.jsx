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

import { authApi } from '../services/authApi.js';
import { validateAuthForm } from '../services/authValidation.js';
import { LOGIN_NOT_CONFIRMED } from '../services/sessionFlow.js';

const registrationMessages = {
  EMAIL_ALREADY_EXISTS: 'Этот email уже зарегистрирован. Попробуй войти.',
  REGISTRATION_CLOSED: 'Регистрация сейчас закрыта.',
  VALIDATION_FAILED: 'Проверь отмеченные поля.',
  SERVICE_UNAVAILABLE: 'Сервис временно недоступен. Попробуй позже.',
  CSRF_INVALID: 'Не удалось проверить безопасность формы. Обнови страницу и попробуй снова.',
  CSRF_NOT_INITIALIZED: 'Не удалось проверить безопасность формы. Обнови страницу и попробуй снова.',
  NETWORK_ERROR: 'Не удалось подтвердить создание аккаунта. Проверь соединение и попробуй войти.',
  INVALID_RESPONSE: 'Не удалось подтвердить создание аккаунта. Проверь соединение и попробуй войти.',
};

const loginMessages = {
  INVALID_CREDENTIALS: 'Неверный email или пароль.',
  VALIDATION_FAILED: 'Проверь отмеченные поля.',
  CSRF_INVALID: registrationMessages.CSRF_INVALID,
  CSRF_NOT_INITIALIZED: registrationMessages.CSRF_NOT_INITIALIZED,
  SERVICE_UNAVAILABLE: registrationMessages.SERVICE_UNAVAILABLE,
  LOGIN_NOT_CONFIRMED,
};

function loginErrorMessage(error) {
  const message = loginMessages[error?.code];
  return typeof message === 'string'
    ? message
    : 'Не удалось войти. Проверь подключение и попробуй позже.';
}

function registrationErrorMessage(error) {
  const message = registrationMessages[error?.code];

  if (typeof message === 'string') {
    return message;
  }

  return error?.status >= 500
    ? registrationMessages.SERVICE_UNAVAILABLE
    : 'Не удалось создать аккаунт. Попробуй позже.';
}

export default function AuthPage({
  mode,
  initialMessage = '',
  onRegistered,
  onLogin,
  onModeChange,
  onOpenDemo,
}) {
  const isRegister = mode === 'register';

  const formRef = useRef(null);
  const headingRef = useRef(null);
  const requestRef = useRef(null);
  const submitLockRef = useRef(false);
  const serverErrorFocusRef = useRef('');

  const [values, setValues] = useState({
    displayName: '',
    email: '',
    password: '',
  });

  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(initialMessage);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });

    return () => requestRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!isSubmitting && serverErrorFocusRef.current) {
      formRef.current?.elements
        .namedItem(serverErrorFocusRef.current)
        ?.focus();

      serverErrorFocusRef.current = '';
    }
  }, [isSubmitting]);

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

  async function handleSubmit(event) {
    event.preventDefault();

    // Синхронная защита, в том числе до перерисовки disabled-кнопки.
    if (submitLockRef.current) {
      return;
    }
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

    const controller = new AbortController();
    requestRef.current = controller;
    submitLockRef.current = true;
    setIsSubmitting(true);

    try {
      if (isRegister) {
        await authApi.register(values, { signal: controller.signal });
      } else {
        await onLogin(values, { signal: controller.signal });
      }

      if (controller.signal.aborted) {
        return;
      }

      setValues({ displayName: '', email: '', password: '' });
      setShowPassword(false);
      if (isRegister) {
        onRegistered();
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      // Неверный email и неверный пароль всегда дают одно общее сообщение.
      const allowedFields = isRegister
        ? ['displayName', 'email', 'password']
        : error?.code === 'VALIDATION_FAILED' ? ['email', 'password'] : [];
      const serverErrors = Object.fromEntries(
        allowedFields
          .filter((field) => typeof error?.fieldErrors?.[field] === 'string')
          .map((field) => [field, error.fieldErrors[field]]),
      );

      setErrors(serverErrors);
      serverErrorFocusRef.current = Object.keys(serverErrors)[0] ?? '';
      setMessage(isRegister ? registrationErrorMessage(error) : loginErrorMessage(error));
      // POST автоматически не повторяем: результат мог сохраниться.
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        submitLockRef.current = false;

        if (!controller.signal.aborted) {
          setIsSubmitting(false);
        }
      }
    }
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
            {isRegister ? 'Регистрация' : 'Вход'}
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
            aria-busy={isSubmitting}
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
                      disabled={isSubmitting}
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
              disabled={isSubmitting}
            >
              {isSubmitting
                ? isRegister ? 'Создаём аккаунт…' : 'Входим…'
                : isRegister ? 'Создать аккаунт' : 'Войти'}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>

          <p className="auth-development-note">
            {isRegister
              ? 'После регистрации нужно войти в аккаунт.'
              : 'Вход в аккаунт StudyMate. Демо доступно без аккаунта.'}
          </p>

          <p className="auth-switch">
            {isRegister
              ? 'Уже есть аккаунт?'
              : 'Ещё нет аккаунта?'}{' '}

            <button
              type="button"
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
