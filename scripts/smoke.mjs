// Runs INSIDE the compose network (see scripts/smoke-compose.sh), once per "machine":
//   node smoke.mjs attacker   - floods and brute-forces
//   node smoke.mjs victim     - an ordinary customer + the account owner, working at the same time
// Every machine is its own container, so nginx sees a different source address for each.
const BASE = process.env.BASE_URL ?? 'http://nginx';
const role = process.argv[2];
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${role}] ${name}${extra ? ' - ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (path, o = {}) => {
  const res = await fetch(BASE + path, {
    method: o.method ?? 'GET',
    headers: {
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.headers ?? {}),
    },
    body:
      o.body === undefined
        ? undefined
        : typeof o.body === 'string'
          ? o.body
          : JSON.stringify(o.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    headers: res.headers,
    json: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })(),
  };
};
const login = async (email, password, headers) =>
  call('/api/auth/login', { method: 'POST', body: { email, password }, headers });
const cookieOf = (r) => (r.headers.get('set-cookie') ?? '').split(';')[0];

async function attacker() {
  // 1. flood the API as fast as possible
  const flood = await Promise.all(Array.from({ length: 600 }, () => call('/api/me')));
  const throttled = flood.filter((r) => r.status === 429).length;
  check('flooding from one machine is throttled', throttled > 300, `${throttled}/600 got 429`);
  check(
    'flooding never causes a 5xx',
    flood.every((r) => r.status === 401 || r.status === 429),
  );

  // 2. brute-force the victim's account, rotating forged X-Forwarded-For values
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    statuses.push(
      (await login('customer2@shop.test', `guess-${i}`, { 'X-Forwarded-For': `10.9.8.${i}` }))
        .status,
    );
    await sleep(250); // stay under the nginx login rate so the application limiter is what answers
  }
  check(
    'password guessing is cut off by the application (429) despite forged X-Forwarded-For',
    statuses.filter((s) => s === 429).length >= 6,
    statuses.join(','),
  );
  const right = await login('customer2@shop.test', 'Customer123!');
  check(
    "even the right password is refused for the attacker's address while blocked",
    right.status === 429,
  );

  // 3. oversized body, bad webhook signatures
  const big = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(500_000) }),
  });
  check('oversized body is rejected at the edge (413)', big.status === 413, String(big.status));
  const hook = await call('/api/payments/webhook', {
    method: 'POST',
    body: '{"x":1}',
    headers: { 'x-signature': 't=1,v1=00' },
  });
  check(
    'webhook with a bad signature is refused',
    hook.status === 401 || hook.status === 429,
    String(hook.status),
  );
}

async function victim() {
  await sleep(300); // let the flood start
  const failures = [];
  const ok = async (name, fn) => {
    try {
      const r = await fn();
      if (!r) failures.push(name);
    } catch (e) {
      failures.push(`${name}: ${e}`);
    }
  };
  // the ordinary customer keeps shopping while the attacker hammers the site
  const session = await login('customer1@shop.test', 'Customer123!');
  check('customer can log in during the attack', session.status === 200, String(session.status));
  const cookie = cookieOf(session);
  for (let i = 0; i < 40; i++) {
    await ok('catalogue', async () => (await call('/api/products?limit=5')).status === 200);
    await ok('me', async () => (await call('/api/me', { cookie })).status === 200);
    await ok('cart', async () => (await call('/api/cart', { cookie })).status === 200);
    await ok('home page', async () => (await call('/uk')).status === 200);
    await sleep(100);
  }
  check(
    '160 requests during the attack all succeeded',
    failures.length === 0,
    failures.slice(0, 3).join('; '),
  );

  // the owner of the attacked account (customer2) logs in from ANOTHER machine
  const owner = await login('customer2@shop.test', 'Customer123!');
  check(
    "account owner is NOT locked out by the attacker's guessing",
    owner.status === 200,
    String(owner.status),
  );

  const docs = await call('/docs-json');
  check(
    'swagger document is served',
    docs.status === 200 && docs.json?.paths?.['/orders'] !== undefined,
  );
  const noSig = await call('/api/payments/webhook', { method: 'POST', body: '{}' });
  check('webhook without signature is refused', noSig.status === 401, String(noSig.status));
  const cors = await call('/api/products', { headers: { Origin: 'https://evil.example' } });
  check('no permissive CORS header', cors.headers.get('access-control-allow-origin') === null);
  const csrf = await call('/api/cart/promo', {
    method: 'POST',
    cookie,
    body: { code: 'X' },
    headers: { Origin: 'https://evil.example' },
  });
  check(
    'state-changing request from a foreign origin is refused',
    csrf.status === 403,
    String(csrf.status),
  );
}

await (role === 'attacker'
  ? attacker()
  : role === 'victim'
    ? victim()
    : Promise.reject(new Error('role?')));
process.exit(results.every(Boolean) ? 0 : 1);
