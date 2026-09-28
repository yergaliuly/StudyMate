import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '../src/services/apiClient.js';
import {
  prepareSubjectValues,
  createSubjectAttempt,
} from '../src/services/subjectDraft.js';

const FORM = Object.freeze({
  title: 'Базы данных',
  description: 'SQL, таблицы и связи',
  icon: 'database',
  tone: 'blue',
});
const DAY = 24 * 60 * 60 * 1000;
const KEYS = [
  'f873a9be-83c4-4de5-a3aa-724a41a078ef',
  'a10e56e7-3d74-4e06-8556-42af1b3e794a',
];

function invalidField(field) {
  return (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.equal(typeof error.fieldErrors[field], 'string');
    assert.ok(error.fieldErrors[field].length > 0);
    assert.ok(Object.keys(error.fieldErrors).every((name) => (
      ['title', 'description', 'icon', 'tone'].includes(name)
    )));
    return true;
  };
}

test('Форма нормализует пробелы, оставляет только поля предмета и не меняет исходные значения', () => {
  const source = Object.freeze({
    ...FORM,
    title: '  Базы\t\n данных  ',
    description: '  SQL, таблицы и связи  ',
    userId: 'foreign-account',
    version: 11,
    password: 'не поле предмета',
  });

  assert.deepEqual(prepareSubjectValues(source), FORM);
  assert.equal(source.title, '  Базы\t\n данных  ');
  assert.notEqual(prepareSubjectValues(FORM), FORM);
  assert.equal(prepareSubjectValues({ ...FORM, description: undefined }).description, '');

  for (const icon of ['book', 'database', 'languages', 'code']) {
    for (const tone of ['blue', 'purple', 'indigo', 'green']) {
      const result = prepareSubjectValues({ ...FORM, icon, tone });
      assert.equal(result.icon, icon);
      assert.equal(result.tone, tone);
    }
  }
});

test('Длины проверяются после нормализации в единицах UTF-16: название 2–60, описание до 160', () => {
  for (const title of ['Аб', 'я'.repeat(60), '😀'.repeat(30), '  А\t Б  ']) {
    assert.doesNotThrow(() => prepareSubjectValues({ ...FORM, title }));
  }
  for (const title of ['', ' ', 'Я', 'я'.repeat(61), '😀'.repeat(31)]) {
    assert.throws(() => prepareSubjectValues({ ...FORM, title }), invalidField('title'));
  }
  for (const description of ['', 'я'.repeat(160), '😀'.repeat(80), `  ${'я'.repeat(160)}  `]) {
    assert.doesNotThrow(() => prepareSubjectValues({ ...FORM, description }));
  }
  for (const description of ['я'.repeat(161), '😀'.repeat(81)]) {
    assert.throws(() => prepareSubjectValues({ ...FORM, description }), invalidField('description'));
  }
});

test('Неверные типы и неизвестные иконка или цвет дают ошибки только разрешённых полей', () => {
  for (const field of ['title', 'description', 'icon', 'tone']) {
    for (const value of [null, 42, false, [], {}]) {
      assert.throws(() => prepareSubjectValues({ ...FORM, [field]: value }), invalidField(field));
    }
  }
  assert.throws(() => prepareSubjectValues({ ...FORM, icon: 'unknown' }), invalidField('icon'));
  assert.throws(() => prepareSubjectValues({ ...FORM, tone: 'red' }), invalidField('tone'));

  assert.throws(() => prepareSubjectValues({
    title: 42,
    description: null,
    icon: 'unknown',
    tone: 'red',
    ownerId: 'foreign-account',
  }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.deepEqual(Object.keys(error.fieldErrors).sort(), ['description', 'icon', 'title', 'tone']);
    return true;
  });
});

test('Ручной повтор неизменённой формы до 24 часов сохраняет исходную попытку и ключ', () => {
  let currentTime = 1000;
  let generated = 0;
  const dependencies = {
    now: () => currentTime,
    randomUUID: () => {
      generated += 1;
      return KEYS[0];
    },
  };
  const first = createSubjectAttempt(FORM, null, dependencies);

  currentTime += DAY - 1;
  const retry = createSubjectAttempt({
    ...FORM,
    title: ' Базы\t данных ',
    description: ' SQL, таблицы и связи ',
  }, first, dependencies);

  assert.equal(retry, first);
  assert.equal(retry.key, KEYS[0]);
  assert.equal(retry.createdAt, 1000);
  assert.deepEqual(retry.values, FORM);
  assert.equal(generated, 1);
});

test('Через 24 часа прежняя форма требует явного решения, новый ключ не создаётся автоматически', () => {
  let generated = 0;
  const randomUUID = () => {
    generated += 1;
    return KEYS[0];
  };
  const first = createSubjectAttempt(FORM, null, { now: () => 1000, randomUUID });

  for (const age of [DAY, DAY + 1, 2 * DAY]) {
    assert.throws(() => createSubjectAttempt(FORM, first, {
      now: () => first.createdAt + age,
      randomUUID,
    }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'IDEMPOTENCY_EXPIRED');
      return true;
    });
  }
  assert.equal(generated, 1);
});

test('Изменение любого поля создаёт новую попытку, даже если предыдущая уже просрочена', () => {
  const first = createSubjectAttempt(FORM, null, { now: () => 1000, randomUUID: () => KEYS[0] });
  const changes = {
    title: 'Алгоритмы',
    description: '',
    icon: 'book',
    tone: 'green',
  };

  for (const [field, value] of Object.entries(changes)) {
    let generated = 0;
    const next = createSubjectAttempt({ ...FORM, [field]: value }, first, {
      now: () => 1000 + DAY,
      randomUUID: () => {
        generated += 1;
        return KEYS[1];
      },
    });
    assert.notEqual(next, first);
    assert.equal(next.key, KEYS[1]);
    assert.equal(next.values[field], value);
    assert.equal(next.createdAt, 1000 + DAY);
    assert.equal(generated, 1);
  }
  assert.equal(first.key, KEYS[0]);
  assert.deepEqual(first.values, FORM);
});

test('Попытка хранит неизменяемый снимок: последующее редактирование формы не меняет тело повтора', () => {
  const source = { ...FORM };
  const attempt = createSubjectAttempt(source, null, { now: () => 1000, randomUUID: () => KEYS[0] });
  source.title = 'Совсем другой предмет';
  source.description = 'Другое описание';

  assert.notEqual(attempt.values, source);
  assert.deepEqual(attempt.values, FORM);
  assert.ok(Object.isFrozen(attempt.values));
  assert.throws(() => { attempt.values.title = 'Случайная перезапись'; }, TypeError);
  assert.equal(createSubjectAttempt(FORM, attempt, { now: () => 1001 }), attempt);
});

test('Неверная форма не расходует новый ключ и не меняет предыдущую попытку', () => {
  const first = createSubjectAttempt(FORM, null, { now: () => 1000, randomUUID: () => KEYS[0] });
  let generated = 0;
  const dependencies = {
    now: () => 1001,
    randomUUID: () => {
      generated += 1;
      return KEYS[1];
    },
  };

  for (const previous of [null, first]) {
    assert.throws(() => createSubjectAttempt({ ...FORM, title: '' }, previous, dependencies), invalidField('title'));
  }
  assert.equal(generated, 0);
  assert.deepEqual(first.values, FORM);
});
