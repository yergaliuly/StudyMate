import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMaterialUploadAttempt,
} from '../src/services/materialUploadDraft.js';

const SUBJECT_ID = 'c6f924b2-b4b0-4926-8d28-a7409a3f2710';
const OTHER_SUBJECT_ID = 'd6f924b2-b4b0-4926-8d28-a7409a3f2711';
const KEY = '12345678-1234-4234-8234-123456789012';
const NEXT_KEY = '22345678-1234-4234-8234-123456789013';

const USAGE = {
  usedBytes: 512,
  reservedBytes: 256,
  limitBytes: 5120,
  maxUploadBytes: 1024,
};

// Проверяем только предварительную проверку метаданных.
// Проверка содержимого настоящего PDF выполняется backend.
function pdf({
  size = 32,
  name = 'lecture.pdf',
  type = 'application/pdf',
} = {}) {
  return new File([new Uint8Array(size)], name, { type });
}

function values(overrides = {}) {
  return {
    file: pdf(),
    subjectId: SUBJECT_ID,
    title: 'Лекция',
    ...overrides,
  };
}

function create(input, usage = USAGE, previous = null) {
  return createMaterialUploadAttempt(input, usage, previous, {
    randomUUID: () => KEY,
  });
}

function expectError(action, code, field) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code);

    if (field) {
      assert.equal(typeof error.fieldErrors[field], 'string');
    }

    return true;
  });
}

test('Нормализуются название и UUID; File сохраняется, лишние поля не попадают в запрос', () => {
  const file = pdf();

  const attempt = create(values({
    file,
    subjectId: SUBJECT_ID.toUpperCase(),
    title: '  Лекция\t  первая  ',
    ownerId: 'не отправлять',
    status: 'stored',
  }));

  assert.equal(attempt.key, KEY);
  assert.equal(attempt.values.subjectId, SUBJECT_ID);
  assert.equal(attempt.values.title, 'Лекция первая');
  assert.equal(attempt.values.file, file);

  assert.deepEqual(
    Object.keys(attempt.values).sort(),
    ['file', 'subjectId', 'title'],
  );
});

test('Отсутствующее и пустое название передаются серверу без выдуманного имени', () => {
  for (const title of [undefined, '', '   ']) {
    assert.equal(create(values({ title })).values.title, '');
  }
});

test('Вместо File нельзя передать null, Blob или объект с именем', () => {
  for (const file of [
    null,
    undefined,
    new Blob(['pdf']),
    { name: 'lecture.pdf', size: 32 },
  ]) {
    expectError(
      () => create(values({ file })),
      'VALIDATION_FAILED',
      'file',
    );
  }
});

test('Некорректный предмет отклоняется до создания ключа', () => {
  let keys = 0;

  for (const subjectId of [null, '', 'demo-subject']) {
    expectError(
      () => createMaterialUploadAttempt(
        values({ subjectId }),
        USAGE,
        null,
        {
          randomUUID: () => {
            keys += 1;
            return KEY;
          },
        },
      ),
      'VALIDATION_FAILED',
      'subjectId',
    );
  }

  assert.equal(keys, 0);
});

test('Принимаются PDF, octet-stream и отсутствующий MIME', () => {
  for (const type of [
    'application/pdf',
    'application/octet-stream',
    '',
  ]) {
    const file = pdf({ type, name: 'Lecture.PDF' });
    assert.equal(create(values({ file })).values.file, file);
  }
});

test('Чужой MIME и неподходящее имя дают ошибку файла', () => {
  const files = [
    pdf({ type: 'text/plain' }),
    pdf({ name: 'lecture.txt' }),
    pdf({ name: 'lecture.pdf.exe' }),
    pdf({ name: 'bad\u0000name.pdf' }),
    pdf({ name: 'a'.repeat(177) + '.pdf' }),
  ];

  for (const file of files) {
    expectError(
      () => create(values({ file })),
      'VALIDATION_FAILED',
      'file',
    );
  }
});

test('Непустой PDF с именем ровно 180 символов проходит предварительную проверку', () => {
  const file = pdf({
    name: 'a'.repeat(176) + '.pdf',
  });

  assert.equal(create(values({ file })).values.file, file);

  expectError(
    () => create(values({ file: pdf({ size: 0 }) })),
    'VALIDATION_FAILED',
    'file',
  );
});

test('Название проверяется после нормализации; Unicode-пары допустимы', () => {
  assert.equal(
    create(values({
      title: '  ' + 'а'.repeat(160) + '  ',
    })).values.title.length,
    160,
  );

  assert.equal(
    create(values({ title: 'Лекция 📚' })).values.title,
    'Лекция 📚',
  );

  for (const title of [
    null,
    123,
    'а'.repeat(161),
    'A\u0000B',
    'A\uD800B',
  ]) {
    expectError(
      () => create(values({ title })),
      'VALIDATION_FAILED',
      'title',
    );
  }
});

test('Размер сравнивается с лимитом сервера; равенство допустимо', () => {
  const file = pdf({
    size: USAGE.maxUploadBytes,
  });

  assert.equal(create(values({ file })).values.file, file);
});

test('Превышение размера даже на один байт не создаёт ключ', () => {
  let keys = 0;

  expectError(
    () => createMaterialUploadAttempt(
      values({
        file: pdf({ size: USAGE.maxUploadBytes + 1 }),
      }),
      USAGE,
      null,
      {
        randomUUID: () => {
          keys += 1;
          return KEY;
        },
      },
    ),
    'VALIDATION_FAILED',
    'file',
  );

  assert.equal(keys, 0);
});

test('Доступное место учитывает резерв; точное заполнение разрешено', () => {
  const input = values({
    file: pdf({ size: 1024 }),
  });

  const usage = {
    ...USAGE,
    usedBytes: 3840,
    reservedBytes: 256,
  };

  assert.equal(
    create(input, usage).values.file,
    input.file,
  );

  expectError(
    () => create(input, {
      ...usage,
      reservedBytes: 257,
    }),
    'STORAGE_QUOTA_EXCEEDED',
  );
});

test('Без корректной квоты новая попытка не создаётся', () => {
  const invalid = [
    null,
    undefined,
    {},
    { ...USAGE, usedBytes: -1 },
    { ...USAGE, reservedBytes: 0.5 },
    { ...USAGE, limitBytes: 0 },
    { ...USAGE, maxUploadBytes: 0 },
    { ...USAGE, maxUploadBytes: USAGE.limitBytes + 1 },
    { ...USAGE, reservedBytes: USAGE.limitBytes },
    { ...USAGE, limitBytes: Number.MAX_SAFE_INTEGER + 1 },
  ];

  let keys = 0;

  for (const usage of invalid) {
    expectError(
      () => createMaterialUploadAttempt(
        values(),
        usage,
        null,
        {
          randomUUID: () => {
            keys += 1;
            return KEY;
          },
        },
      ),
      'STORAGE_USAGE_REQUIRED',
    );
  }

  assert.equal(keys, 0);
});

test('Повтор сохраняет тот же объект попытки и ключ даже при заполненной квоте', () => {
  const input = values();
  const first = create(input);
  let keys = 0;

  const repeated = createMaterialUploadAttempt(
    {
      ...input,
      title: '  Лекция  ',
      subjectId: SUBJECT_ID.toUpperCase(),
    },
    {
      ...USAGE,
      usedBytes: USAGE.limitBytes,
      reservedBytes: 0,
    },
    first,
    {
      randomUUID: () => {
        keys += 1;
        return NEXT_KEY;
      },
    },
  );

  assert.equal(repeated, first);
  assert.equal(repeated.values.file, input.file);
  assert.equal(keys, 0);
});

test('Повтор разрешён при недоступной квоте, поскольку первый запрос мог сохранить файл', () => {
  const input = values();
  const first = create(input);

  assert.equal(create(input, null, first), first);
});

for (const change of ['file', 'title', 'subjectId']) {
  test('Изменение ' + change + ' не заменяет незавершённую попытку новым ключом', () => {
    const input = values();
    const first = create(input);

    const modified = {
      ...input,
      [change]: change === 'file'
        ? pdf()
        : change === 'title'
          ? 'Другое название'
          : OTHER_SUBJECT_ID,
    };

    let keys = 0;

    expectError(
      () => createMaterialUploadAttempt(
        modified,
        USAGE,
        first,
        {
          randomUUID: () => {
            keys += 1;
            return NEXT_KEY;
          },
        },
      ),
      'UPLOAD_ATTEMPT_LOCKED',
    );

    assert.equal(keys, 0);
    assert.equal(first.values.file, input.file);
    assert.equal(first.values.title, 'Лекция');
    assert.equal(first.values.subjectId, SUBJECT_ID);
  });
}

test('Попытка и её поля неизменяемы', () => {
  const input = values();
  const attempt = create(input);

  assert.equal(Object.isFrozen(attempt), true);
  assert.equal(Object.isFrozen(attempt.values), true);

  assert.throws(() => {
    attempt.key = NEXT_KEY;
  }, TypeError);

  assert.throws(() => {
    attempt.values.title = 'Подмена';
  }, TypeError);

  assert.throws(() => {
    attempt.values.file = pdf();
  }, TypeError);

  assert.equal(attempt.values.file, input.file);
});

test('Новая явно начатая попытка получает новый ключ', () => {
  const input = values();
  const first = create(input);

  const next = createMaterialUploadAttempt(
    input,
    USAGE,
    null,
    {
      randomUUID: () => NEXT_KEY,
    },
  );

  assert.notEqual(next.key, first.key);
  assert.notEqual(next, first);
  assert.equal(next.values.file, first.values.file);
});

test('Некорректный результат генерации ключа не становится попыткой', () => {
  for (const key of ['', 'not-a-uuid', null]) {
    expectError(
      () => createMaterialUploadAttempt(
        values(),
        USAGE,
        null,
        {
          randomUUID: () => key,
        },
      ),
      'IDEMPOTENCY_KEY_UNAVAILABLE',
    );
  }
});