// Только проверка формы.
// Запросов и сохранения пароля здесь нет.

export function validateAuthForm(values, mode) {
  const errors = {};

  const email = values.email.trim();
  const password = values.password; // Не вызываем trim().

  if (mode === 'register') {
    const displayName = values.displayName.trim();

    if (displayName.length < 1 || displayName.length > 60) {
      errors.displayName =
        'Имя должно содержать от 1 до 60 символов.';
    }
  }

  if (!email) {
    errors.email = 'Укажи email.';
  } else if (email.length > 254) {
    errors.email =
      'Email должен содержать не больше 254 символов.';
  } else {
    const emailInput = document.createElement('input');

    emailInput.type = 'email';
    emailInput.value = email;

    if (
      emailInput.value !== email ||
      emailInput.validity.typeMismatch
    ) {
      errors.email =
        'Введи корректный email, например student@example.com.';
    }
  }

  if (!password) {
    errors.password = 'Введи пароль.';
  } else if (password.length > 128) {
    errors.password =
      'Пароль должен содержать не больше 128 символов.';
  } else if (mode === 'register' && password.length < 12) {
    errors.password =
      'Для регистрации нужен пароль длиной от 12 символов.';
  }

  return errors;
}