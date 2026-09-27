# StudyMate backend

Этап 3: аккаунты и `POST /api/v1/auth/register` поверх каркаса Spring Boot/PostgreSQL.
Регистрация проверяется с реальной БД и включёнными фильтрами безопасности через MockMvc.
CSRF обязателен; endpoint получения токена, вход, выход, текущий пользователь и сессии
JDBC появятся на этапе 4. До этого полноценное подключение форм frontend недоступно.
Технический `GET /actuator/health` работает. Контракт: [API](../docs/api.md),
дальнейшие этапы: [архитектура](../docs/architecture.md).

## Версии

| Компонент | Версия |
| --- | --- |
| Java | JDK 21; сборка отклоняет другие major-версии |
| Spring Boot | 4.1.1 |
| Maven / Wrapper | 3.9.16 / 3.3.4, официальный only-script |
| Flyway | 12.4.0, из BOM Spring Boot |
| PostgreSQL JDBC | 42.7.13, из BOM Spring Boot |
| Spring Security | 7.1.1, из BOM Spring Boot |
| Bouncy Castle | bcprov-jdk18on 1.86, закреплён явно для Argon2 |
| PostgreSQL | Major-версия 17; локальная проверка на 17.2 |

Версии проверены 2026-09-27 по [требованиям Spring Boot](https://docs.spring.io/spring-boot/system-requirements.html),
[BOM 4.1.1](https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-dependencies/4.1.1/spring-boot-dependencies-4.1.1.pom)
и [стабильному выпуску Maven](https://maven.apache.org/download.cgi).
Bouncy Castle проверен по [официальному выпуску](https://www.bouncycastle.org/download/bouncy-castle-java/).
Wrapper проверяет SHA-256 дистрибутива Maven. Глобальный Maven не нужен.
JDK и сервер PostgreSQL устанавливаются отдельно; Wrapper их не устанавливает.
17.2 описывает имеющееся локальное окружение, не фиксирует patch для выпуска:
перед размещением выбираются актуальные поддерживаемые patch PostgreSQL 17 и JDK 21.

## Локальная база и настройки

Нужны отдельная база UTF-8 PostgreSQL 17 и роль с паролем, владеющая этой базой.
Пример в `psql` под локальным администратором, пароль задаётся интерактивно:

```sql
CREATE ROLE studymate LOGIN;
\password studymate
CREATE DATABASE studymate OWNER studymate ENCODING 'UTF8' TEMPLATE template0;
```

Приложение подключается этой ролью, не суперпользователем. Flyway нужны права создавать
схему и таблицы в своей базе. Разделение ролей миграций/runtime уточняется перед выпуском.
Существующая БД другого проекта не подходит. Docker необязателен; автоматически
создавать сервисы, контейнеры и базы приложение не будет.

Имена переменных перечислены в [.env.example](.env.example).
Spring Boot **не читает `.env` автоматически**: задай переменные в конфигурации запуска
IDE или текущем терминале. Пароль передавай отдельно, не в JDBC URL, командной строке или Git.

PowerShell, из `backend/`:

```powershell
$env:JAVA_HOME = 'C:\path\to\jdk-21'
$env:STUDYMATE_DATABASE_URL = 'jdbc:postgresql://127.0.0.1:5432/studymate'
$env:STUDYMATE_DATABASE_USERNAME = 'studymate'
$taskDbCredential = Get-Credential -UserName 'studymate' -Message 'Пароль локальной базы'
$env:STUDYMATE_DATABASE_PASSWORD = $taskDbCredential.GetNetworkCredential().Password
.\mvnw.cmd -v
.\mvnw.cmd spring-boot:run
```

По умолчанию сервер слушает `127.0.0.1:8080`. Проверка из другого терминала:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/actuator/health
```

Ожидается `{"status":"UP"}`. Health проверяет соединение с БД; при её недоступности
после запуска возвращает 503 и `{"status":"DOWN"}` без адресов и подробностей.
Это технический endpoint Actuator, поэтому он не использует бизнес-оболочку `data`.
Недоступная БД или отсутствие обязательных настроек подключения останавливают запуск.
Ctrl+C останавливает приложение. После работы очисти пароль в терминале:
`Remove-Item Env:\STUDYMATE_DATABASE_PASSWORD` и `Remove-Variable taskDbCredential`.

Linux/macOS: `sh ./mvnw` вместо `.\mvnw.cmd`; нужны JDK 21, `unzip` и `sha256sum` либо `shasum`.
Первая сборка требует сети для Maven Central. Сборка и запуск JAR с теми же переменными:

```powershell
.\mvnw.cmd verify
& "$env:JAVA_HOME\bin\java.exe" -jar target/studymate-backend-0.1.0-SNAPSHOT.jar
```

## Что защищено сейчас

Открыты GET health и маршрут POST регистрации, защищённый CSRF и флагом регистрации.
Остальные маршруты закрыты `denyAll`; анонимный GET получает `401 AUTHENTICATION_REQUIRED`,
изменяющий запрос без CSRF — `403 CSRF_INVALID`. Эти ответы на будущих маршрутах
**не означают их реализацию**.
Нет стандартного пользователя Spring, HTML-формы входа и Basic Auth.
Cookie-аутентификация, CORS/proxy и Spring Session JDBC добавляются на этапе 4.
Multipart отключён до согласования загрузки на этапе 8; R2 и ИИ пока не подключаются.

MVC, servlet error dispatch и Spring Security используют
`{"error":{"code":"...","message":"...","fieldErrors":{}}}` и `Cache-Control: no-store`.
Повреждённый JSON даёт 400, неверные поля/типы и Bean Validation — 422.
Неизвестные поля и неявное преобразование числа/boolean в строку запрещены.
Неожиданные исключения дают безопасный 500; в журнал пишется тип без текста
исключения, SQL или входных данных. Не включай подробные логи запросов с секретами.

## Регистрация на этапе 3

По умолчанию `STUDYMATE_REGISTRATION_ENABLED=false`, в том числе локально.
Для явного включения в разработке перед запуском:

```powershell
$env:STUDYMATE_REGISTRATION_ENABLED = 'true'
```

Это разрешает создание аккаунтов, но не отключает CSRF и не добавляет вход.
Без токена POST возвращает `403 CSRF_INVALID`; с корректным токеном при закрытой
регистрации — `403 REGISTRATION_CLOSED`. Пока `/auth/csrf` не реализован, токен
предоставляет только тестовая инфраструктура Spring Security; обхода для браузера нет.
Не считать этот этап готовым публичным запуском: частотные лимиты, политика доступа
пилота и подтверждение email ещё впереди.

Регистрация принимает только `email`, `password`, `displayName` и возвращает
`201 {"data":{"id":"<server UUID>","email":"...","displayName":"..."}}`, без автоматического входа.
Email обрезается по правилам JS trim и приводится к нижнему регистру через Locale.ROOT;
точки и plus-часть сохраняются. В ответе — тот же нормализованный email, что хранится в БД.
Имя обрезается только по краям. Пароль не обрезается и не нормализуется, длины — UTF-16.
Проверки и сообщения полей соответствуют [API](../docs/api.md).

Пароли хешируются Argon2id: 19 МиБ, 2 итерации, параллелизм 1, соль 16 байт,
хеш 32 байта. Параметры следуют [минимуму OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html);
кодирование выполняет [Spring Security](https://docs.spring.io/spring-security/reference/7.0/features/authentication/password-storage.html).
В БД сохраняется строка `{argon2id}$argon2id$...` с солью и параметрами, без исходного пароля.
Стоимость хеширования нужно повторно оценить на выбранном хостинге до пилота.

Уникальность `normalized_email` защищена ограничением PostgreSQL. Единственный INSERT
с `ON CONFLICT` создаёт аккаунт либо возвращает `409 EMAIL_ALREADY_EXISTS` и `fieldErrors.email`.
Предварительный SELECT не используется; повтор не меняет имя или хеш существующего аккаунта.

## Миграции

Каталог — `src/main/resources/db/migration/`. Flyway выполняется до готовности приложения;
история — `public.flyway_schema_history`. V1 создаёт схему `studymate`, V2 — таблицу `users`.
Применённая V1 не менялась. Правила: [migrations/README.md](migrations/README.md).

## Проверки

Тесты валидации, хеширования и MVC без PostgreSQL: `.\mvnw.cmd test`.
Полная проверка дополнительно запускает HTTP-сервер на случайном порту и миграции
на **отдельной тестовой PostgreSQL 17**. Создай её аналогично локальной базе,
с отдельной ролью и именем, например `studymate_test`. Перед первым прогоном база пустая.
Проверки можно повторять на той же тестовой базе; `clean` запрещён.
Тесты регистрации оставляют вымышленные аккаунты с уникальными адресами `@example.com`.
Они не используют `STUDYMATE_DATABASE_*` и не должны получать адрес рабочей базы:

```powershell
$env:STUDYMATE_TEST_DATABASE_URL = 'jdbc:postgresql://127.0.0.1:5432/studymate_test'
$env:STUDYMATE_TEST_DATABASE_USERNAME = 'studymate_test'
$taskTestCredential = Get-Credential -UserName 'studymate_test' -Message 'Пароль тестовой базы'
$env:STUDYMATE_TEST_DATABASE_PASSWORD = $taskTestCredential.GetNetworkCredential().Password
.\mvnw.cmd -Ppostgres-it verify
Remove-Item Env:\STUDYMATE_TEST_DATABASE_PASSWORD
Remove-Variable taskTestCredential
```

Без тестовых переменных профиль `postgres-it` падает, а не пропускает проверки.
Обычный `verify` выполняет только быстрые тесты и сборку JAR; это не проверка PostgreSQL.
Отчёты: `target/surefire-reports/` и `target/failsafe-reports/`.
Проверяются JSON ошибок, валидация, отсутствие утечек, HTTP 200/401/403,
отсутствие стандартного аккаунта, миграция схемы, UTC соединения, повтор миграций
и запрет Flyway clean. Для регистрации проверяются 201/409/422, Unicode и длины,
нормализация email, соль/хеш, запрет без CSRF, закрытый режим и одновременные запросы.
Успешная регистрация проверяется через MockMvc с настоящей PostgreSQL и тестовым CSRF,
а health/отказы без CSRF — также через настоящий HTTP. Браузерный сценарий — этап 4.
Тестовые контроллеры находятся только в `src/test/java`.
Этап 2 проверен 2026-09-27 на Windows, JDK 21.0.6 и отдельном PostgreSQL 17.2:
18 MVC-тестов и 4 интеграционных теста прошли без пропусков.
Отдельно проверены запуск JAR с обычной ролью БД, миграция пустой базы, перезапуск
без повторного применения V1, health 503 при остановке БД и отказ запуска без БД/настроек.
Временные процессы остановлены; данные и кеши остались в игнорируемом `tmp/`.
Существующие базы и службы не менялись. Linux/macOS и Docker в этом этапе не проверялись.

Этап 3: 57 быстрых и 10 интеграционных тестов прошли на той же связке JDK/PostgreSQL.
Проверены чистая БД и обновление V1 → V2 с обычной ролью, неизменность аккаунтов и хешей
после перезапуска временной PostgreSQL. Полный браузерный вход ещё не проверяется.
