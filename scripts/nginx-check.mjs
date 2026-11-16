#!/usr/bin/env node
// Does the nginx edge REALLY work? Not "is the config valid" - does it route, limit, cap, time out and
// fail the way docker/nginx.conf claims, against the running stack.
//
//   run through `pnpm test:stack` (STACK_STEPS="nginx"), or by hand with the stack's compose env:
//   E2E_BASE_URL=http://localhost:18080 COMPOSE_PROJECT_NAME=... node scripts/nginx-check.mjs
//
// It stops and starts the api/web containers (to see what the edge answers when an upstream is down),
// so it must only run against a THROWAWAY stack.
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const BASE = process.env.E2E_BASE_URL;
if (!BASE) {
  console.error('E2E_BASE_URL is not set: run this through `pnpm test:stack`');
  process.exit(2);
}
const { hostname: HOST, port: PORT } = new URL(BASE);

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (...args) =>
  execFileSync('docker', ['compose', ...args], { stdio: 'pipe' }).toString();
const get = async (path, init) => {
  const r = await fetch(BASE + path, { redirect: 'manual', ...init });
  const body = await r.text();
  return { status: r.status, headers: r.headers, body };
};

/** Raw TCP: sends `payload`, then watches the socket until it closes or `maxMs` pass. */
function rawConnection(payload, maxMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let data = '';
    const s = net.connect({ host: HOST, port: Number(PORT) }, () => payload && s.write(payload));
    const done = (how) => {
      s.destroy();
      resolve({ how, ms: Date.now() - started, data });
    };
    s.on('data', (d) => (data += d.toString('latin1')));
    s.on('close', () => done('closed'));
    s.on('error', () => done('error'));
    setTimeout(() => done('open'), maxMs);
  });
}

// ---------------------------------------------------------------------------------------- config
try {
  compose('exec', '-T', 'nginx', 'nginx', '-t');
  check('nginx -t: the configuration is valid', true);
} catch (e) {
  check('nginx -t: the configuration is valid', false, String(e.stderr ?? e).slice(0, 200));
}

// --------------------------------------------------------------------------------------- routing
{
  const web = await get('/uk');
  check('/ goes to the web app', web.status === 200 && /<html/i.test(web.body), String(web.status));
  const health = await get('/api/health');
  check(
    '/api/... goes to the api and the /api prefix is stripped',
    health.status === 200 && health.body.includes('"status":"ok"'),
    health.body.slice(0, 40),
  );
  const bare = await get('/health');
  check(
    'the api is NOT reachable without the /api prefix',
    !bare.body.includes('"status":"ok"'),
    String(bare.status),
  );
  const docs = await get('/docs');
  check(
    '/docs serves Swagger UI',
    docs.status === 200 && /swagger/i.test(docs.body),
    String(docs.status),
  );
  const spec = await get('/docs-json');
  check(
    '/docs-json serves the OpenAPI document',
    spec.status === 200 && spec.body.includes('"openapi"'),
  );
  const nope = await get('/api/definitely-not-here');
  check(
    "an unknown api route is the api's JSON 404 (not nginx's or the web app's)",
    nope.status === 404 && nope.body.includes('"error"'),
    nope.body.slice(0, 50),
  );
}

// -------------------------------------------------------------------------------------- headers
{
  const need = (h) =>
    h.get('x-content-type-options') === 'nosniff' &&
    h.get('x-frame-options') === 'DENY' &&
    Boolean(h.get('referrer-policy'));
  const page = await get('/uk');
  check('security headers on pages', need(page.headers));
  const api = await get('/api/health');
  check('security headers on api responses', need(api.headers));
  const notFound = await get('/api/nope');
  check('security headers on error responses', need(notFound.headers));
  check(
    'the Server header does not reveal the nginx version',
    /^nginx$/i.test(page.headers.get('server') ?? ''),
    String(page.headers.get('server')),
  );
  check(
    'no X-Powered-By header (does not advertise the framework)',
    !page.headers.get('x-powered-by'),
    String(page.headers.get('x-powered-by')),
  );
  const asset = /\/_next\/static\/[^"']+\.(?:js|css)/.exec(page.body)?.[0];
  if (asset) {
    const a = await get(asset);
    check(
      'hashed static assets are cacheable for a year',
      a.status === 200 && /max-age=31536000/.test(a.headers.get('cache-control') ?? ''),
      String(a.headers.get('cache-control')),
    );
  }
  const framed = await get('/api/products?limit=1', {
    headers: { Origin: 'https://evil.example' },
  });
  check(
    'no CORS headers are added for a foreign origin',
    !framed.headers.get('access-control-allow-origin'),
  );
}

// ------------------------------------------------------------- the client address cannot be forged
{
  // whatever X-Forwarded-For / X-Real-IP the client sends is replaced by the address nginx saw, so
  // the api's per-address counters cannot be dodged by lying. 6 guesses at one account, every one
  // "from a different address": the 6th must still be refused.
  const email = 'customer29@shop.test';
  const guess = (i) =>
    fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        'x-forwarded-for': `203.0.113.${i + 1}, 198.51.100.${i + 1}`,
        'x-real-ip': `203.0.113.${i + 100}`,
        forwarded: `for=192.0.2.${i + 1}`,
      },
      body: JSON.stringify({ email, password: `Wrong-guess-${i}` }),
    });
  const first = await guess(0);
  if (first.status === 429) {
    console.log(
      'SKIP forged-address check: customer29 is still locked by an earlier run (use a fresh stack)',
    );
  } else {
    const codes = [first.status];
    for (let i = 1; i < 7; i++) codes.push((await guess(i)).status);
    check(
      'forged X-Forwarded-For / X-Real-IP / Forwarded do not reset the per-address login limit',
      codes.slice(0, 5).every((c) => c === 401) && codes.slice(5).every((c) => c === 429),
      codes.join(','),
    );
  }
}

// ---------------------------------------------------------------------- request rate limiting
{
  await sleep(1500); // let the bucket refill after the checks above
  const codes = await Promise.all(
    Array.from({ length: 200 }, () => fetch(`${BASE}/api/health`).then((r) => r.status)),
  );
  const limited = codes.filter((c) => c === 429).length;
  check(
    'a burst of 200 requests/instant to /api is throttled by nginx (429)',
    limited > 0,
    `${limited}x429, ${codes.filter((c) => c === 200).length}x200`,
  );
  check(
    '...and the allowed part is still served (not everything is blocked)',
    codes.filter((c) => c === 200).length >= 50,
  );
  check(
    '...and it never turns into a 5xx',
    codes.every((c) => c < 500),
  );
  const sample = await fetch(`${BASE}/api/health`);
  if (sample.status === 429) {
    const text = await sample.text();
    check(
      'the throttled answer carries the security headers too',
      sample.headers.get('x-content-type-options') === 'nosniff',
      text.slice(0, 30),
    );
  }
  await sleep(2500);
  const after = await get('/api/health');
  check(
    'the address is served again a moment after the burst (it recovers by itself)',
    after.status === 200,
    String(after.status),
  );

  const pageCodes = await Promise.all(
    Array.from({ length: 40 }, () => fetch(`${BASE}/uk`).then((r) => r.status)),
  );
  check(
    'pages (not /api) are not caught by the api limit',
    pageCodes.every((c) => c === 200),
    [...new Set(pageCodes)].join(','),
  );

  await sleep(1500);
  const logins = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({
          email: `nobody-${i}-${Date.now()}@shop.test`,
          password: 'Wrong-password-1',
        }),
      }).then((r) => r.status),
    ),
  );
  check(
    '/api/auth/login has its own, much stricter limit (40 instant attempts: most are refused)',
    logins.filter((c) => c === 429).length >= 15 && logins.every((c) => c < 500),
    `${logins.filter((c) => c === 429).length}x429, ${logins.filter((c) => c === 401).length}x401`,
  );
  await sleep(4000);
}

// ---------------------------------------------------------------------------------- body size
{
  const post = (n) =>
    fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(n) }),
    }).then(async (r) => ({
      status: r.status,
      body: await r.text(),
      server: r.headers.get('server'),
    }));
  await sleep(1500);
  const huge = await post(260_000);
  check(
    'a 260 KB body is cut off by nginx itself (413)',
    huge.status === 413 && !huge.body.includes('"error"'),
    `${huge.status}`,
  );
  await sleep(300);
  const mid = await post(150_000);
  check(
    "a 150 KB body (above the api limit, below nginx's) is a clean 413 from the api, not a 5xx",
    mid.status === 413,
    `${mid.status}`,
  );
  await sleep(300);
  const small = await post(60_000);
  check(
    'a 60 KB body reaches the api (and is judged by it)',
    small.status === 400 || small.status === 401,
    `${small.status}`,
  );
}

// ------------------------------------------------------------- malformed / hostile requests
{
  await sleep(1500);
  const longUrl = await rawConnection(
    `GET /${'a'.repeat(20_000)} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    3000,
  );
  check(
    'a 20 KB URL is refused by nginx (414)',
    /^HTTP\/1\.1 414/.test(longUrl.data),
    longUrl.data.slice(0, 20),
  );
  const bigHeader = await rawConnection(
    `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(40_000)}\r\nConnection: close\r\n\r\n`,
    3000,
  );
  check(
    'a 40 KB header is refused (400/431), not passed on',
    /^HTTP\/1\.1 4\d\d/.test(bigHeader.data),
    bigHeader.data.slice(0, 20),
  );
  const smuggle = await rawConnection(
    'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n',
    3000,
  );
  check(
    'Content-Length + Transfer-Encoding together (request smuggling shape) is not forwarded as is',
    !/^HTTP\/1\.1 2\d\d/.test(smuggle.data),
    smuggle.data.slice(0, 20),
  );
  const odd = await Promise.all(
    [
      '/api//health',
      '/api/../docs',
      '/api%2Fhealth',
      '/%00',
      '/api/health%00',
      '/.env',
      '/api/.git/config',
      '/..%2f..%2fetc/passwd',
    ].map(async (p) => [p, (await get(p)).status]),
  );
  check(
    'odd paths never cause a 5xx',
    odd.every(([, s]) => s < 500),
    odd.map(([p, s]) => `${p}=${s}`).join(' '),
  );
  const method = await rawConnection(
    'FOO /api/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    3000,
  );
  check(
    'an unknown HTTP method is a 4xx, not a 5xx',
    /^HTTP\/1\.1 [4]\d\d/.test(method.data),
    method.data.slice(0, 20),
  );
  const nohost = await rawConnection('GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n', 3000);
  check(
    'a request without Host is refused or served, never a 5xx',
    !/^HTTP\/1\.1 5/.test(nohost.data),
    nohost.data.slice(0, 20),
  );
}

// -------------------------------------------------------------------- slow and greedy clients
{
  await sleep(1000);
  const slowHeaders = rawConnection('GET / HTTP/1.1\r\nHost: x\r\n', 16_000); // the headers never finish
  const slowBody = rawConnection(
    'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"a":',
    16_000,
  );
  const [h, b] = await Promise.all([slowHeaders, slowBody]);
  check(
    'slowloris: a client that never finishes its headers is dropped after ~10 s',
    h.how !== 'open' && h.ms >= 8000 && h.ms <= 14_000,
    `${h.how} after ${h.ms} ms`,
  );
  check(
    'a client that stalls in the middle of a body is dropped after ~10 s',
    b.how !== 'open' && b.ms >= 8000 && b.ms <= 14_000,
    `${b.how} after ${b.ms} ms ${b.data.slice(9, 12)}`,
  );

  // 70 requests held in progress on a PAGE path (no per-request limit there, so only the connection cap acts): limit_conn counts
  // requests being processed, so the surplus over 50 per address must be refused at once
  const stalled =
    'POST /uk HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"a":';
  const held = await Promise.all(Array.from({ length: 70 }, () => rawConnection(stalled, 3000)));
  const refused = held.filter((c) => /^HTTP\/1\.1 429/.test(c.data)).length;
  check(
    'more than 50 simultaneous requests from one address: the surplus is refused (429)',
    refused >= 10 && refused <= 25,
    `${refused} of 70 refused`,
  );
  await sleep(11_000); // the stalled ones time out (client_body_timeout)
  const alive = await get('/api/health');
  check('...and the stack serves normally right after', alive.status === 200, String(alive.status));
}

// ------------------------------------------------------------------------- an upstream is down
{
  await sleep(2500);
  const started = (name) => compose('start', name);
  const wait = async (path, ok, ms = 90_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        if (ok((await get(path)).status)) return true;
      } catch {
        /* still starting */
      }
      await sleep(1000);
    }
    return false;
  };

  compose('stop', 'api');
  const t0 = Date.now();
  const down = await get('/api/health');
  check(
    'api down: nginx answers 502/503/504 quickly instead of hanging',
    [502, 503, 504].includes(down.status) && Date.now() - t0 < 8000,
    `${down.status} in ${Date.now() - t0} ms`,
  );
  check(
    'api down: the error page does not leak the upstream address',
    !/172\.\d+\.\d+\.\d+|api:4000|upstream/i.test(down.body),
    down.body.slice(0, 60),
  );
  check(
    'api down: nginx still adds the security headers',
    down.headers.get('x-content-type-options') === 'nosniff',
  );
  const stillWeb = await get('/uk');
  check('api down: the web app is still served', stillWeb.status === 200, String(stillWeb.status));
  started('api');
  check(
    'api back: the edge serves it again without being restarted',
    await wait('/api/health', (s) => s === 200),
  );

  compose('stop', 'web');
  const noWeb = await get('/uk');
  check(
    'web down: nginx answers 502/503/504',
    [502, 503, 504].includes(noWeb.status),
    String(noWeb.status),
  );
  const stillApi = await get('/api/health');
  check('web down: the api is still served', stillApi.status === 200, String(stillApi.status));
  started('web');
  check('web back: pages are served again', await wait('/uk', (s) => s === 200));
}

console.log(failed === 0 ? '\nNGINX CHECK PASSED' : `\nNGINX CHECK FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
