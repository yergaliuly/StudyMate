// Real Nginx + temporary HTTPS fixture; never connects to the application backend.
// Native: NGINX_BIN=/path/to/nginx OPENSSL_BIN=openssl node frontend/deploy/tests/proxy-smoke.mjs
// Windows also accepts SH_BIN=/path/to/Git/bin/bash.exe for the entrypoint validator.
// Linux Docker: node frontend/deploy/tests/proxy-smoke.mjs --docker studymate-frontend:test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const dockerImage = args[0] === '--docker' && args.length === 2 ? args[1] : null;
assert(args.length === 0 || dockerImage, 'Use no arguments, or --docker IMAGE');
assert(!dockerImage || process.platform === 'linux', 'Docker mode requires Linux host networking');
const nginxBin = process.env.NGINX_BIN || 'nginx';
const opensslBin = process.env.OPENSSL_BIN || 'openssl';
const temporaryRoot = await realpath(os.tmpdir());
const temporary = await mkdtemp(path.join(temporaryRoot, 'studymate-proxy-'));
const fixtureRequests = [];
const fixtureServers = [];
let stopProxy = async () => {};
let proxyDiagnostics = async () => '';
let csrfSequence = 0;
let session;
let token;

function command(binary, argv) {
  const result = spawnSync(binary, argv, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0,
    `${path.basename(binary)} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function nginxPath(value) {
  return value.replaceAll('\\', '/');
}

function checkValidator() {
  const cases = [
    ['BACKEND_HOST', ''], ['BACKEND_HOST', 'https://localhost'],
    ['BACKEND_HOST', 'localhost:443'], ['BACKEND_HOST', 'localhost/api'],
    ['BACKEND_HOST', 'localhost\ninjected.invalid'], ['BACKEND_HOST', 'localhost\r'],
    ['BACKEND_HOST', '-localhost'], ['BACKEND_HOST', `${'a'.repeat(64)}.invalid`],
    ['BACKEND_HOST', 'localhost;'], ['BACKEND_PORT', ''], ['BACKEND_PORT', '0'],
    ['BACKEND_PORT', '0443'], ['BACKEND_PORT', '65536'], ['BACKEND_PORT', '443\n80'],
  ];
  for (const [field, value] of cases) {
    const environment = { BACKEND_HOST: 'localhost', BACKEND_PORT: '443', [field]: value };
    const result = dockerImage
      ? spawnSync('docker', ['run', '--rm', '--network', 'none',
        '--env', `BACKEND_HOST=${environment.BACKEND_HOST}`,
        '--env', `BACKEND_PORT=${environment.BACKEND_PORT}`,
        dockerImage, 'nginx', '-t'], { encoding: 'utf8' })
      : spawnSync(process.env.SH_BIN || 'sh', [nginxPath(path.join(frontend, 'deploy/15-validate-upstream.sh'))], {
        encoding: 'utf8', windowsHide: true, env: { ...process.env, ...environment },
      });
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0, `${field}=${JSON.stringify(value)} must be rejected before interpolation`);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(`${field} (must be|contains)`),
      'The environment validator, not an unrelated startup failure, must reject invalid input');
  }
  console.log(`PASS ${cases.length} invalid host/port cases, including newline injection`);
}

async function createCertificate(name, dnsName, signedByCa = true) {
  const key = path.join(temporary, `${name}.key`);
  const cert = path.join(temporary, `${name}.crt`);
  const request = path.join(temporary, `${name}.csr`);
  const extensions = path.join(temporary, `${name}.ext`);
  await writeFile(extensions, `subjectAltName=DNS:${dnsName}\nextendedKeyUsage=serverAuth\n`);
  command(opensslBin, ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', request, '-subj', `/CN=${dnsName}`]);
  command(opensslBin, ['x509', '-req', '-in', request,
    ...(signedByCa
      ? ['-CA', path.join(temporary, 'ca.crt'), '-CAkey', path.join(temporary, 'ca.key'), '-CAcreateserial']
      : ['-signkey', key]),
    '-days', '1', '-out', cert, '-extfile', extensions]);
  return { key: await readFile(key), cert: await readFile(cert) };
}

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...headers });
  response.end(JSON.stringify(payload));
}

async function startFixture(certificate) {
  const server = https.createServer(certificate, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = {
      method: request.method, url: request.url, headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'), servername: request.socket.servername,
    };
    fixtureRequests.push(entry);
    const pathname = new URL(request.url, 'https://localhost').pathname;
    if (pathname === '/api/v1/auth/csrf') {
      csrfSequence += 1;
      session = `fixture-session-${csrfSequence}`;
      token = `fixture-token-${csrfSequence}`;
      json(response, 200, { data: { token, headerName: 'X-CSRF-TOKEN' } }, {
        'Set-Cookie': [
          `STUDYMATE_SESSION=${session}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          'FIXTURE_SECOND=present; Path=/; HttpOnly; Secure; SameSite=Lax',
        ],
      });
    } else if (pathname === '/api/v1/echo') {
      if (!request.headers.cookie?.includes(`STUDYMATE_SESSION=${session}`)
          || request.headers['x-csrf-token'] !== token) {
        json(response, 403, { error: { code: 'CSRF_INVALID', message: 'Fixture rejected CSRF' } });
      } else {
        json(response, 200, { data: entry });
      }
    } else if (/^\/api\/v1\/errors\/(401|403|409|503)$/.test(pathname)) {
      const status = Number(pathname.split('/').at(-1));
      json(response, status, { error: { code: `FIXTURE_${status}`, message: 'Exact upstream error' } }, {
        'Retry-After': '7',
      });
    } else {
      json(response, 404, { error: { code: 'FIXTURE_NOT_FOUND', message: 'No such API route' } });
    }
  });
  // Dual stack keeps localhost usable whether Nginx resolves it to ::1 or 127.0.0.1.
  server.listen(0, '::');
  await once(server, 'listening');
  fixtureServers.push(server);
  return server.address().port;
}

async function freePort(preferred = 0) {
  const server = net.createServer();
  server.listen(preferred, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, pathname, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: { Host: 'study.example.test', ...headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode, headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      incoming.on('error', reject);
    });
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('HTTP smoke request timed out')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function startProxy(upstreamPort, run) {
  const port = await freePort(dockerImage ? 8080 : 0);
  if (dockerImage) {
    const name = `studymate-smoke-${process.pid}-${run}`;
    command('docker', ['run', '--detach', '--rm', '--network', 'host', '--name', name,
      '--env', 'BACKEND_HOST=localhost', '--env', `BACKEND_PORT=${upstreamPort}`,
      '--mount', `type=bind,source=${path.join(temporary, 'ca.crt')},target=/etc/ssl/certs/ca-certificates.crt,readonly`,
      dockerImage]);
    stopProxy = async () => { command('docker', ['rm', '--force', name]); };
    proxyDiagnostics = async () => command('docker', ['logs', name]);
  } else {
    const prefix = path.join(temporary, `nginx-${run}`);
    await mkdir(prefix);
    await mkdir(path.join(prefix, 'logs'));
    await mkdir(path.join(prefix, 'temp'));
    const root = nginxPath(path.join(frontend, 'dist'));
    await readFile(path.join(frontend, 'dist/index.html'));
    const template = await readFile(path.join(frontend, 'deploy/default.conf.template'), 'utf8');
    assert.match(template, /listen\s+8080\s*;/, 'Production template must listen on 8080');
    assert(template.includes('/usr/share/nginx/html'), 'Expected production static root');
    assert(template.includes('/etc/ssl/certs/ca-certificates.crt'), 'Expected production CA trust');
    const rendered = template
      .replaceAll('${BACKEND_HOST}', 'localhost')
      .replaceAll('${BACKEND_PORT}', String(upstreamPort))
      .replace(/listen\s+8080\s*;/g, `listen 127.0.0.1:${port};`)
      .replaceAll('/usr/share/nginx/html', root)
      .replaceAll('/etc/ssl/certs/ca-certificates.crt', nginxPath(path.join(temporary, 'ca.crt')));
    const serverConfig = path.join(prefix, 'server.conf');
    await writeFile(serverConfig, rendered);
    const log = path.join(prefix, 'error.log');
    const config = path.join(prefix, 'nginx.conf');
    await writeFile(config, `pid "${nginxPath(path.join(prefix, 'nginx.pid'))}";
error_log "${nginxPath(log)}" info;
events {}
http {
  access_log off;
  client_body_temp_path "${nginxPath(path.join(prefix, 'client-temp'))}";
  proxy_temp_path "${nginxPath(path.join(prefix, 'proxy-temp'))}";
  types { text/html html; application/javascript js; text/css css; }
  include "${nginxPath(serverConfig)}";
}
`);
    const nginxArgs = ['-p', `${nginxPath(prefix)}/`, '-c', nginxPath(config)];
    command(nginxBin, [...nginxArgs, '-t']);
    const child = spawn(nginxBin, [...nginxArgs, '-g', 'daemon off;'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (value) => { output += value; });
    child.stderr.on('data', (value) => { output += value; });
    child.on('error', (error) => { output += error.message; });
    stopProxy = async () => {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        command(nginxBin, [...nginxArgs, '-s', 'quit']);
        await Promise.race([exited, delay(7_000, undefined, { ref: false }).then(() => {
          throw new Error('Nginx did not stop gracefully');
        })]);
      }
    };
    proxyDiagnostics = async () => `${output}\n${await readFile(log, 'utf8').catch(() => '')}`;
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await request(port, '/healthz')).status === 200) return port;
    } catch { /* Wait only for this isolated proxy to start. */ }
    await delay(100);
  }
  throw new Error(`Nginx did not become healthy:\n${await proxyDiagnostics()}`);
}

async function checkProxy(port) {
  const initial = fixtureRequests.length;
  const health = await request(port, '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'UP' });
  assert.equal(fixtureRequests.length, initial, 'Frontend health must not call the API');
  const index = await request(port, '/');
  assert.equal(index.status, 200);
  assert.match(index.body, /<div id="root"><\/div>/);
  assert.match(index.headers['cache-control'], /no-cache|no-store/);
  assert.equal((await request(port, '/subjects/example')).body, index.body, 'SPA route returns index');
  const assetPath = index.body.match(/src="(\/assets\/[^"\s]+\.js)"/)?.[1];
  assert(assetPath, 'Production index must reference its built JavaScript');
  const asset = await request(port, assetPath);
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.match(asset.headers['cache-control'], /immutable/);
  assert(asset.body.length > 0);
  const missingAsset = await request(port, '/assets/missing-smoke.js');
  assert.equal(missingAsset.status, 404);
  assert.notEqual(missingAsset.body, index.body);
  assert.equal((await request(port, '/api')).status, 404);
  console.log('PASS static build, SPA fallback, missing assets, frontend-only health');

  const csrf1 = await request(port, '/api/v1/auth/csrf');
  const csrf2 = await request(port, '/api/v1/auth/csrf');
  assert.equal(csrf1.status, 200);
  assert.equal(csrf2.status, 200);
  assert.notEqual(csrf1.body, csrf2.body, 'API responses must not be cached');
  assert.match(csrf2.headers['cache-control'], /no-store/);
  const cookies = csrf2.headers['set-cookie'];
  assert.equal(cookies.length, 2, 'Both Set-Cookie headers survive');
  assert.match(cookies[0], /^STUDYMATE_SESSION=fixture-session-\d+; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  const csrf = JSON.parse(csrf2.body).data;
  const idempotency = '36f1d9f2-e4e4-4aa8-a1f6-94182041b82a';
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const body = JSON.stringify({ title: 'Учебный PDF', version: 3, method });
    const url = '/api/v1/echo?query=%D1%82%D0%B5%D1%81%D1%82&page=2&value=a%2Fb';
    const response = await request(port, url, { method, body, headers: {
      'Content-Type': 'application/json', Cookie: cookie,
      [csrf.headerName]: csrf.token, 'Idempotency-Key': idempotency,
      'X-Forwarded-For': '198.51.100.99', 'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'spoof.invalid', 'X-Forwarded-Port': '80',
      'X-Real-IP': '198.51.100.99', 'X-Forwarded-Prefix': '/spoof',
      Forwarded: 'for=198.51.100.99;host=spoof.invalid;proto=http',
    } });
    assert.equal(response.status, 200);
    const forwarded = JSON.parse(response.body).data;
    assert.equal(forwarded.method, method);
    assert.equal(forwarded.url, url);
    assert.equal(forwarded.body, body);
    assert.equal(forwarded.headers['content-type'], 'application/json');
    assert.equal(forwarded.headers.cookie, cookie);
    assert.equal(forwarded.headers['x-csrf-token'], csrf.token);
    assert.equal(forwarded.headers['idempotency-key'], idempotency);
    assert.equal(forwarded.headers.host, 'localhost');
    assert.equal(forwarded.servername, 'localhost');
    assert.equal(forwarded.headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(forwarded.headers['x-real-ip'], '127.0.0.1');
    assert.equal(forwarded.headers['x-forwarded-proto'], 'https');
    assert.equal(forwarded.headers['x-forwarded-host'], 'study.example.test');
    assert.equal(forwarded.headers['x-forwarded-port'], '443');
    assert.equal(forwarded.headers.forwarded, undefined);
    assert.equal(forwarded.headers['x-forwarded-prefix'], undefined);
  }
  const invalidCsrf = await request(port, '/api/v1/echo', { method: 'POST', headers: {
    Cookie: cookie, 'X-CSRF-TOKEN': 'wrong-fixture-token',
  } });
  assert.equal(invalidCsrf.status, 403);
  assert.equal(JSON.parse(invalidCsrf.body).error.code, 'CSRF_INVALID');
  console.log('PASS cookie/CSRF/idempotency transport, JSON methods/query, trusted forwarding and TLS SNI');

  for (const status of [401, 403, 409, 503]) {
    const before = fixtureRequests.length;
    const response = await request(port, `/api/v1/errors/${status}`, { method: 'POST', body: '{"once":true}' });
    assert.equal(response.status, status);
    assert.deepEqual(JSON.parse(response.body), { error: { code: `FIXTURE_${status}`, message: 'Exact upstream error' } });
    assert.equal(response.headers['retry-after'], '7');
    assert.equal(fixtureRequests.length, before + 1, 'A failed mutation must reach the fixture exactly once');
  }
  const missing = await request(port, '/api/v1/not-a-route?x=1');
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error.code, 'FIXTURE_NOT_FOUND');
  assert.match(missing.headers['content-type'], /application\/json/);
  console.log('PASS upstream errors/Retry-After, no automatic mutation retry or API SPA fallback');
}

try {
  checkValidator();
  command(opensslBin, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(temporary, 'ca.key'), '-out', path.join(temporary, 'ca.crt'),
    '-subj', '/CN=StudyMate smoke temporary CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  const valid = await startFixture(await createCertificate('valid', 'localhost'));
  const wrongHost = await startFixture(await createCertificate('wrong-host', 'wrong.invalid'));
  const untrusted = await startFixture(await createCertificate('untrusted', 'localhost', false));
  const port = await startProxy(valid, 'trusted');
  await checkProxy(port);
  await stopProxy();
  stopProxy = async () => {};
  for (const [name, upstream] of [['wrong-host', wrongHost], ['untrusted-ca', untrusted]]) {
    const negativePort = await startProxy(upstream, name);
    const before = fixtureRequests.length;
    assert.equal((await request(negativePort, '/api/v1/auth/csrf')).status, 502, `${name} TLS must fail closed`);
    assert.equal(fixtureRequests.length, before, 'Invalid TLS must not reach the fixture HTTP handler');
    assert.equal((await request(negativePort, '/healthz')).status, 200, 'Frontend health is independent of upstream TLS');
    console.log(`PASS TLS verification rejects ${name}`);
    await stopProxy();
    stopProxy = async () => {};
  }
  console.log(`Proxy smoke passed (${dockerImage ? 'Docker image' : 'native Nginx'}). No real backend calls.`);
} catch (error) {
  console.error(error);
  console.error(await proxyDiagnostics().catch(() => 'Proxy diagnostics unavailable'));
  process.exitCode = 1;
} finally {
  await stopProxy().catch((error) => { console.error(error); process.exitCode = 1; });
  for (const server of fixtureServers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert(path.resolve(temporary).startsWith(`${path.resolve(temporaryRoot)}${path.sep}studymate-proxy-`),
    'Cleanup must stay inside the generated temporary directory');
  await rm(temporary, { recursive: true, force: true });
}
