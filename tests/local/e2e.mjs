// Browser end-to-end test of 연문회 OS against the LOCAL Postgres.
// Supabase HTTP calls are intercepted and executed the way PostgREST would
// (role anon, or authenticated with the JWT "sub"). Realtime is not emulated,
// so pages rely on refreshes after their own actions / polling.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SB = 'https://xuuoyzhksctpzxcylhwe.supabase.co';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const pool = new pg.Pool({ host: '/var/lib/postgresql/rn', port: 5433, user: 'postgres', database: 'rn' });
const SHOTS = process.env.SHOTS ?? '/tmp/rn-shots';
fs.mkdirSync(SHOTS, { recursive: true });

// ---- static server
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const BASE = `http://localhost:${server.address().port}`;

// ---- fake PostgREST + GoTrue
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (sub) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, email: 'admin@test' })}.sig`;

async function handle(route) {
  const req = route.request();
  const url = new URL(req.url());
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

  if (url.pathname.startsWith('/auth/v1/token')) {
    const body = JSON.parse(req.postData() || '{}');
    if (body.password !== 'pw') return route.fulfill({ status: 400, headers: cors, json: { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' } });
    const user = { id: ADMIN, email: body.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    return route.fulfill({ status: 200, headers: cors, json: { access_token: fakeJwt(ADMIN), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user } });
  }
  if (url.pathname.startsWith('/auth/v1/user')) {
    return route.fulfill({ status: 200, headers: cors, json: { id: ADMIN, email: 'admin@test', aud: 'authenticated', role: 'authenticated' } });
  }
  if (url.pathname.startsWith('/auth/v1/logout')) return route.fulfill({ status: 204, headers: cors });

  if (url.pathname === '/rest/v1/realtime_signals') {          // the version poll (anon can read this table)
    const keys = (url.searchParams.get('key') ?? '').replace(/^in\.\(|\)$/g, '').split(',').map(k => k.replace(/^"|"$/g, '')).filter(Boolean);
    const r = await pool.query('select key, version from public.realtime_signals where key = any($1)', [keys]);
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(r.rows.map(x => ({ key: x.key, version: Number(x.version) }))) });
  }
  const m = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
  if (!m) return route.fulfill({ status: 404, headers: cors, body: '' });
  const args = JSON.parse(req.postData() || '{}');
  const auth = req.headers()['authorization'] ?? '';
  let sub = null;
  try { sub = JSON.parse(Buffer.from(auth.replace(/^Bearer /, '').split('.')[1], 'base64url')).sub ?? null; } catch { /* anon */ }

  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${sub ? 'authenticated' : 'anon'}`);
    if (sub) await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    const keys = Object.keys(args);
    const r = await c.query(`select public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`,
      keys.map(k => Array.isArray(args[k]) ? args[k]                          // text[] params (PostgREST sends arrays as arrays)
        : (args[k] !== null && typeof args[k] === 'object') ? JSON.stringify(args[k]) : args[k]));
    await c.query('commit');
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(r.rows[0].r) });
  } catch (e) {
    await c.query('rollback').catch(() => {});
    return route.fulfill({ status: e.code === '42501' ? 401 : 400, headers: cors,
      json: { code: e.code, message: e.message, details: e.detail ?? null, hint: null } });
  } finally { c.release(); }
}

// ---- browser
const browser = await chromium.launch();
const errors = [];
async function newUser(name, sid, { mobile = false, entered = true } = {}) {
  const ctx = await browser.newContext(mobile ? { ...devices['iPhone 13'] } : { viewport: { width: 1280, height: 800 } });
  await ctx.route(`${SB}/**`, handle);
  await ctx.routeWebSocket?.(/supabase\.co/, ws => ws.close?.());
  if (entered && name) {
    await ctx.addInitScript(([n, s]) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('rn.name', n); localStorage.setItem('rn.sid', s); sessionStorage.setItem('seeded', '1');
      }
    }, [name, sid]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', e => { errors.push(`[${name}] ${e.message}`); console.error(`[${name}] pageerror`, e.message); });
  page.on('dialog', d => d.accept());
  return page;
}
const win = (p, key) => p.locator(`.win[data-key="${key}"]`);

let passed = 0;
async function step(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e.message.split('\n').slice(0, 6).join('\n     ')); process.exitCode = 1; }
}

console.log('연문회 OS e2e (local)');
await pool.query(`insert into app.admins(user_id) values ($1) on conflict do nothing`, [ADMIN]);

let storyId;

await step('first visit: boot log, login window, validation, enter -> drawer', async () => {
  const p = await newUser('first', null, { entered: false });
  await p.goto(`${BASE}/`);
  await p.waitForSelector('.bootlog >> text=로그인 대기');
  await p.waitForSelector('.win[data-key="login"]');
  assert.ok(await p.evaluate(() => document.body.classList.contains('crt')), 'CRT on by default');
  await p.screenshot({ path: `${SHOTS}/01-login-desktop.png` });
  await p.fill('#lg-name', '김철수');
  await p.fill('#lg-sid', '12 34$');
  await p.click('text=들어가기');
  await p.waitForSelector('text=학번을 확인해 주세요');
  await p.fill('#lg-sid', '2026-100001');
  await p.click('text=들어가기');
  await p.waitForSelector('.win[data-key="stories"]');
  assert.equal(await p.locator('.win[data-key="login"]').count(), 0);
  assert.equal(await p.locator('.bootlog').count(), 0);
  assert.match(await p.textContent('#menubar'), /김철수 님/);
  assert.equal(await p.evaluate(() => localStorage.getItem('rn.sid')), '2026100001');

  // new story via desktop icon
  await p.click('.icon[data-route="/new"]');
  await p.waitForSelector('#ns-text');
  await p.fill('#ns-title', 'E2E 이야기');
  await p.fill('#ns-text', '옛날 옛적에 작은 마을이 있었다.');
  await p.click('.win[data-key="new"] button[type=submit]');
  await p.waitForURL(/#\/story\//);
  storyId = p.url().split('/story/')[1];
  await p.waitForSelector(`.win[data-key="story:${storyId}"] .line`);
  assert.equal(await p.locator('.win[data-key="new"]').count(), 0, 'new-story window closed');
  assert.match(await win(p, `story:${storyId}`).locator('.win-title').textContent(), /E2E 이야기/);

  // starter cannot continue
  await p.waitForSelector('text=1줄까지 쓸 수 있어요');                           // said before pressing
  assert.ok(await win(p, `story:${storyId}`).locator('button:text-is("이어 쓰기")').isDisabled());
});

await step('deep link + writer B: claim, counter, Enter submits -> line 2', async () => {
  const b = await newUser('이영희', '2026100002');
  await b.goto(`${BASE}/#/story/${storyId}`);
  const w = win(b, `story:${storyId}`);
  await w.waitFor();
  assert.equal(await b.locator('.win[data-key="stories"]').count(), 1, 'drawer open behind');
  assert.match(await w.textContent(), /이영희 님으로 써요/);
  await w.locator('button:text-is("이어 쓰기")').click();
  await w.locator('textarea').waitFor();
  assert.match(await w.textContent(), /2번째 줄/);
  await w.locator('textarea').fill('마을에는 이상한 우체통이 하나 있었다.');
  assert.equal(await w.locator('.counter').textContent(), '21 / 100');
  await w.locator('textarea').press('Enter');
  await b.waitForFunction(id => document.querySelectorAll(`.win[data-key="story:${id}"] .line:not(.pending)`).length === 2, storyId);
  assert.match(await w.textContent(), /줄이 올라갔어요/);
  await b.screenshot({ path: `${SHOTS}/02-story-desktop.png` });
});

await step('baton held by D: C sees pending row, gets baton_held; D late -> conflict -> rewrite', async () => {
  const d = await newUser('최지우', '2026100004');
  await d.goto(`${BASE}/#/story/${storyId}`);
  const wd = win(d, `story:${storyId}`);
  await wd.locator('button:text-is("이어 쓰기")').click();
  await wd.locator('textarea').waitFor();
  const c = await newUser('박민수', '2026100003');
  await c.goto(`${BASE}/#/story/${storyId}`);
  const wc = win(c, `story:${storyId}`);
  await wc.locator('.line.pending').waitFor();
  assert.match(await wc.textContent(), /다른 사람이 쓰는 중이에요/);
  await wc.locator('button:text-is("이어 쓰기")').click();
  await wc.locator('text=다른 사람이 이어 쓰는 중이에요').waitFor();
  await pool.query(`update app.stories set baton_expires_at = now() - interval '1 s' where baton_name = '최지우'`);
  await wc.locator('button:text-is("이어 쓰기")').click();
  await wc.locator('textarea').fill('우체통은 밤마다 편지를 뱉어냈다.');
  await wc.locator('text=올리기').click();
  await c.waitForFunction(id => document.querySelectorAll(`.win[data-key="story:${id}"] .line:not(.pending)`).length === 3, storyId);
  await wd.locator('textarea').fill('그 우체통에는 주인이 없었다.');
  await wd.locator('text=올리기').click();
  await wd.locator('text=저장 충돌').waitFor();
  assert.equal(await wd.locator('.line:not(.pending)').count(), 3, 'conflict not shown publicly');
  await d.screenshot({ path: `${SHOTS}/03-conflict.png` });
  await wd.locator('text=새 줄에 다시 쓰기').click();
  await wd.locator('textarea').waitFor();
  assert.equal(await wd.locator('textarea').inputValue(), '그 우체통에는 주인이 없었다.');
  assert.match(await wd.textContent(), /4번째 줄/);
  await wd.locator('text=취소').click();
  await wd.locator('button:text-is("이어 쓰기")').waitFor();
});

await step('writer reveal: 속성 window with name + student id, Escape closes', async () => {
  const b = await newUser('이영희', '2026100002');
  await b.goto(`${BASE}/#/story/${storyId}`);
  const w = win(b, `story:${storyId}`);
  await w.locator('.line').first().waitFor();
  assert.ok(!(await w.textContent()).includes('김철수'));
  // desktop: hover shows, leaving hides
  await w.locator('.who').first().hover();
  await b.locator('.props').waitFor();
  assert.match(await b.locator('.props').textContent(), /김철수.*2026100001/);
  assert.equal(await w.locator('.line.is-revealed').count(), 1, 'reveal#1');
  await b.screenshot({ path: `${SHOTS}/04-reveal.png` });
  await b.mouse.move(5, 400);
  await b.locator('.props').waitFor({ state: 'detached' });
  assert.equal(await w.locator('.line.is-revealed').count(), 0, 'reveal#2');
  // moving from the icon into the window keeps it open
  await w.locator('.who').nth(1).hover();
  await b.locator('.props').waitFor();
  const pb = await b.locator('.props').boundingBox();
  await b.mouse.move(pb.x + 20, pb.y + 30, { steps: 4 });
  await b.waitForTimeout(400);
  assert.equal(await b.locator('.props').count(), 1, 'stays open while pointer is on it');
  await b.mouse.move(5, 400);
  await b.locator('.props').waitFor({ state: 'detached' });
  // click pins it
  await w.locator('.who').first().click();
  await b.mouse.move(5, 400);
  await b.waitForTimeout(400);
  assert.equal(await b.locator('.props').count(), 1, 'pinned');
  // keyboard: Enter toggles
  await b.keyboard.press('Escape');
  assert.equal(await b.locator('.props').count(), 0, 'reveal#3');
  await w.locator('.who').nth(2).focus();
  await b.keyboard.press('Enter');
  await b.locator('.props').waitFor();
  await b.keyboard.press('Escape');
  assert.equal(await b.locator('.props').count(), 0, 'reveal#4');
  assert.equal(await w.locator('.line.is-revealed').count(), 0, 'reveal#5');
});

await step('final-line warning and 완결 stamp', async () => {
  await pool.query(`update app.stories set max_lines = 4 where id = $1`, [storyId]);
  const e = await newUser('정하늘', '2026100005');
  await e.goto(`${BASE}/#/story/${storyId}`);
  const w = win(e, `story:${storyId}`);
  await w.locator('button:text-is("이어 쓰기")').click();
  await w.locator('text=마지막 줄이에요').waitFor();
  await w.locator('textarea').fill('그리고 마을은 다시 조용해졌다.');
  await w.locator('text=올리기').click();
  await w.locator('.story-head:not([hidden]) svg[aria-label="완결 도장"]').waitFor();
  assert.match(await w.textContent(), /이야기가 완결됐어요/);
  assert.ok(await e.locator('.seal-drop').count() <= 1);
  assert.match(await w.locator('.record summary').textContent(), /4줄 · 원고지 [\d.]+매 · 4명/);
  await w.locator('.record summary').click();
  await w.locator('.relay-facts >> text=가장 빠른 바통').waitFor();
  await e.waitForTimeout(2700);
  await e.screenshot({ path: `${SHOTS}/05-complete.png` });
  await e.click('.icon[data-route="/stories"]');
  assert.match(await win(e, 'stories').textContent(), /완결/);
});

await step('guest: browse read-only, writing asks to log in, then returns to the story', async () => {
  const id = (await pool.query(`select public.create_story('손님 테스트', '시작합니다.', '작가', '20269000', 'seed') as r`)).rows[0].r.story_id;
  const g = await newUser('guest', null, { entered: false });
  await g.goto(`${BASE}/#/story/${id}`);
  await g.waitForSelector('.win[data-key="login"]');
  await g.click('text=둘러보기 (읽기만)');
  const w = win(g, `story:${id}`);
  await w.waitFor();
  assert.match(await g.textContent('#menubar'), /손님/);
  await w.locator('text=로그인하고 이어 쓰기').click();
  await g.locator('.win[data-key="login"] >> text=글을 쓰려면 로그인해 주세요').waitFor();
  await g.fill('#lg-name', '손님이었던 사람');
  await g.fill('#lg-sid', '2026100009');
  await g.click('text=들어가기');
  await w.locator('button:text-is("이어 쓰기")').waitFor();
  assert.match(await w.textContent(), /손님이었던 사람 님으로 써요/);
  assert.match(g.url(), new RegExp(`#/story/${id}`));
});

await step('방명록: post, reveal, cooldown, guest prompt', async () => {
  const b = await newUser('이영희', '2026100002');
  await b.goto(`${BASE}/#/guestbook`);
  const w = win(b, 'guestbook');
  await w.locator('text=아직 아무도 남기지 않았어요').waitFor();
  await w.locator('textarea').fill('우체통 이야기 결말 너무 궁금해요');
  await w.locator('button:has-text("남기기")').click();
  await w.locator('.note').first().waitFor();
  assert.match(await w.locator('.note').first().textContent(), /#001.*우체통 이야기 결말/);
  await w.locator('text=초 후 다시').waitFor();
  await w.locator('.note .who').first().click();
  assert.match(await b.locator('.props').textContent(), /이영희.*2026100002/);
  await b.screenshot({ path: `${SHOTS}/06-guestbook.png` });
  await b.keyboard.press('Escape');
  // a second post inside 30 s is refused by the server too
  await pool.query(`select public.post_guestbook('두 번째', '이영희', '2026100002', 'x')`).then(() => assert.fail('cooldown not enforced')).catch(e => assert.match(e.message, /cooldown/));
  const g = await newUser('guest2', null, { entered: false });
  await g.goto(`${BASE}/#/guestbook`);
  await g.click('text=둘러보기 (읽기만)');
  await win(g, 'guestbook').locator('text=로그인하고 남기기').click();
  await g.locator('text=방명록을 남기려면 로그인해 주세요').waitFor();
});

await step('출석부: hidden until admin enables stats', async () => {
  const b = await newUser('이영희', '2026100002');
  await b.goto(`${BASE}/#/roster`);
  await win(b, 'roster').locator('text=출석부는 아직 공개되지 않았어요').waitFor();
  await pool.query(`update app.settings set stats_public = true`);
  await b.reload();
  await win(b, 'roster').locator('td:has-text("김철수")').waitFor();
  await pool.query(`update app.settings set stats_public = false`);
});

await step('desktop windows: drag, position remembered, focus order, close', async () => {
  const b = await newUser('이영희', '2026100002');
  await b.goto(`${BASE}/`);
  const drawer = win(b, 'stories');
  await drawer.waitFor();
  const t = drawer.locator('.win-title');
  const box = await t.boundingBox();
  await b.mouse.move(box.x + 100, box.y + 10);
  await b.mouse.down();
  await b.mouse.move(box.x + 300, box.y + 160, { steps: 5 });
  await b.mouse.up();
  const after = await drawer.boundingBox();
  assert.ok(Math.abs(after.x - (box.x + 200)) < 4 && Math.abs(after.y - (box.y + 150)) < 4, 'moved');
  await b.reload();
  const again = await win(b, 'stories').boundingBox();
  assert.ok(Math.abs(again.x - after.x) < 4 && Math.abs(again.y - after.y) < 4, 'remembered');
  // resize from the corner grip; can't go below the minimum; size is remembered
  const grip = win(b, 'stories').locator('.win-grip');
  const g = await grip.boundingBox();
  const before = await win(b, 'stories').boundingBox();
  await b.mouse.move(g.x + 8, g.y + 8); await b.mouse.down();
  await b.mouse.move(g.x + 128, g.y + 88, { steps: 5 }); await b.mouse.up();
  const bigger = await win(b, 'stories').boundingBox();
  assert.ok(Math.abs(bigger.width - before.width - 120) < 4 && Math.abs(bigger.height - before.height - 80) < 4, 'resized');
  const g2 = await grip.boundingBox();
  await b.mouse.move(g2.x + 8, g2.y + 8); await b.mouse.down();
  await b.mouse.move(g2.x - 900, g2.y - 900, { steps: 5 }); await b.mouse.up();
  const tiny = await win(b, 'stories').boundingBox();
  assert.ok(tiny.width >= 379 && tiny.height >= 299, `min size kept (${tiny.width}x${tiny.height})`);
  await b.reload();
  const kept = await win(b, 'stories').boundingBox();
  assert.ok(Math.abs(kept.width - tiny.width) < 3 && Math.abs(kept.height - tiny.height) < 3, 'size remembered');
  // double-click the title to zoom, again to restore
  await win(b, 'stories').locator('.win-title h2').dblclick();
  const zoomed = await win(b, 'stories').boundingBox();
  assert.ok(zoomed.width > 1000, 'zoomed');
  await win(b, 'stories').locator('.win-title h2').dblclick();
  assert.ok(Math.abs((await win(b, 'stories').boundingBox()).width - kept.width) < 3, 'restored');
  await b.screenshot({ path: `${SHOTS}/17-resized.png` });

  await b.click('#menubar >> text=도움말');
  await win(b, 'help').waitFor();
  assert.ok(await win(b, 'help').evaluate(el => el.classList.contains('is-active')));
  assert.match(b.url(), /#\/help$/);
  await win(b, 'stories').locator('.win-bar').click({ position: { x: 8, y: 8 } });
  assert.ok(await win(b, 'stories').evaluate(el => el.classList.contains('is-active')));
  assert.match(b.url(), /#\/stories$/);
  await win(b, 'help').locator('.win-close').click();
  assert.equal(await win(b, 'help').count(), 0);
  await b.screenshot({ path: `${SHOTS}/13-desktop-dragged.png` });
});

await step('log out closes every window and returns to the login screen', async () => {
  const b = await newUser('이영희', '2026100002');
  await b.goto(`${BASE}/#/guestbook`);
  await win(b, 'guestbook').waitFor();
  await b.click('.icon[data-route="/roster"]');
  await win(b, 'roster').waitFor();
  await b.click('#menubar >> text=로그아웃');
  await b.waitForSelector('.win[data-key="login"]');
  assert.deepEqual(await b.$$eval('.win', ws => ws.map(w => w.dataset.key)), ['login']);
  assert.ok(!b.url().includes('#/'), 'route cleared');
  await b.fill('#lg-name', '다른 사람');
  await b.fill('#lg-sid', '2026100077');
  await b.click('text=들어가기');
  await win(b, 'stories').waitFor();
  assert.match(await b.textContent('#menubar'), /다른 사람 님/);
});

await step('CRT: switch on login screen and in the menu bar, remembered', async () => {
  const p = await newUser('crt', null, { entered: false });
  await p.goto(`${BASE}/`);
  await p.waitForSelector('.win[data-key="login"]');
  await p.click('.seg >> text=끔');
  assert.equal(await p.evaluate(() => document.body.classList.contains('crt')), false);
  await p.click('text=둘러보기 (읽기만)');
  await p.reload();
  await win(p, 'stories').waitFor();
  assert.equal(await p.evaluate(() => document.body.classList.contains('crt')), false, 'remembered');
  await p.click('#menubar >> text=CRT 끔');
  assert.equal(await p.evaluate(() => document.body.classList.contains('crt')), true);
});

await step('mobile: one window at a time, dock navigation, sheet reveal, composer', async () => {
  const m = await newUser('이영희', '2026100002', { mobile: true });
  await m.goto(`${BASE}/`);
  await win(m, 'stories').waitFor();
  assert.ok(await m.locator('#dock').isVisible());
  assert.ok(!(await m.locator('#icons').isVisible()));
  await m.screenshot({ path: `${SHOTS}/07-mobile-drawer.png` });
  await win(m, 'stories').locator('.drawer-row', { hasText: '손님 테스트' }).click();
  const w = m.locator('.win.is-active');
  await w.locator('.line').first().waitFor();
  assert.equal(await m.locator('.win:visible').count(), 1, 'only one window visible');
  await w.locator('.who').first().click();
  await m.locator('.props.sheet').waitFor();
  await m.screenshot({ path: `${SHOTS}/08-mobile-sheet.png` });
  await m.locator('.win-bar').first().tap?.().catch(() => {});
  await m.mouse.click(10, 300);
  assert.equal(await m.locator('.props').count(), 0);
  await w.locator('button:text-is("이어 쓰기")').click();
  await w.locator('textarea').waitFor();
  await m.screenshot({ path: `${SHOTS}/09-mobile-writing.png` });
  await w.locator('text=취소').click();
  await m.click('#dock >> text=방명록');
  await win(m, 'guestbook').waitFor();
  assert.equal(await m.locator('.win:visible').count(), 1);
  assert.equal(await m.locator('#dock a[aria-current="page"]').textContent(), '방명록');
  await m.screenshot({ path: `${SHOTS}/10-mobile-guestbook.png` });
  await m.goBack();
  await m.waitForFunction(() => document.querySelector('.win.is-active')?.dataset.key.startsWith('story:'));
});

await step('mobile first visit: boot + login fit on screen', async () => {
  const m = await newUser('m2', null, { mobile: true, entered: false });
  await m.goto(`${BASE}/`);
  await m.waitForSelector('.win[data-key="login"]');
  await m.waitForSelector('.bootlog >> text=로그인 대기');
  const box = await m.locator('.win[data-key="login"]').boundingBox();
  const vp = m.viewportSize();
  assert.ok(box.y + box.height <= vp.height, 'login window fits');
  await m.screenshot({ path: `${SHOTS}/11-mobile-login.png` });
  // entering brings the dock up: the cat must sit on it right away (it used to stay below until a reload)
  await m.fill('#lg-name', '새사람');
  await m.fill('#lg-sid', '2026100777');
  await m.click('text=들어가기');
  await m.waitForSelector('.win[data-key="stories"]');
  await m.waitForTimeout(600);
  const cat = await m.locator('.cat').boundingBox();
  const dock = await m.locator('.dock').boundingBox();
  assert.ok(cat && cat.height > 0, 'the cat is shown');
  assert.ok(cat.y + cat.height <= dock.y + 4 && cat.y > dock.y - 80, `the cat sits on the dock (cat ${cat.y}..${cat.y + cat.height}, dock ${dock.y})`);
});

async function adminLogin(p) {
  await p.goto(`${BASE}/`);
  await p.waitForSelector('.win[data-key="login"]');
  await p.fill('#lg-name', 'admin@test');
  assert.equal(await p.getAttribute('#lg-sid', 'type'), 'password', 'easter egg: 학번 becomes a password field');
  await p.fill('#lg-sid', 'pw');
  await p.click('text=들어가기');
  await p.waitForSelector('.win[data-key="admin"]');
}

await step('hidden admin login: wrong password is refused like a normal error', async () => {
  const p = await newUser('x', null, { entered: false });
  await p.goto(`${BASE}/`);
  await p.waitForSelector('.win[data-key="login"]');
  await p.fill('#lg-name', 'admin@test');
  await p.fill('#lg-sid', 'nope');
  await p.click('text=들어가기');
  await p.waitForSelector('text=로그인 정보를 확인해 주세요');
  assert.equal(await p.locator('.win[data-key="admin"]').count(), 0);
  await p.fill('#lg-name', '보통 사람');
  assert.equal(await p.getAttribute('#lg-sid', 'type'), 'text', 'back to a normal field');
});

await step('admin console: conflict swap via OS dialog, guestbook hide, settings, story window rewind', async () => {
  const p = await newUser('admin', null, { entered: false });
  await adminLogin(p);
  assert.match(await p.textContent('#menubar'), /관리/);
  const c = win(p, 'admin');
  await c.locator('text=바꿔 넣기 (뒤 줄 유지)').first().waitFor();
  await p.screenshot({ path: `${SHOTS}/14-admin-console.png` });
  await c.locator('text=바꿔 넣기 (뒤 줄 유지)').first().click();
  await p.locator('.modal .dialog').waitFor();
  await p.screenshot({ path: `${SHOTS}/15-admin-dialog.png` });
  await p.locator('.modal >> text=확인').click();
  await c.locator('text=바꿔 넣었어요').waitFor();
  await c.locator('text=확인할 충돌이 없어요').waitFor();

  await c.locator('.tabs >> text=방명록').click();
  await c.locator('td:has-text("우체통 이야기 결말")').waitFor();
  await c.locator('button:has-text("숨기기")').first().click();
  await c.locator('text=숨겼어요').waitFor();
  assert.equal((await pool.query(`select public.list_guestbook() as r`)).rows[0].r.total, 0, 'guestbook hidden');

  await c.locator('.tabs >> text=설정').click();
  await c.locator('input[name=guestbook_max_chars]').fill('150');
  await c.locator('button:has-text("저장")').click();
  await c.locator('text=설정을 저장했어요').waitFor();
  assert.equal((await pool.query(`select guestbook_max_chars from app.settings`)).rows[0].guestbook_max_chars, 150);

  await c.locator('.tabs >> text=이야기').click();
  await c.locator(`a.rowlink:has-text("E2E 이야기")`).click();
  const sw = win(p, `admin-story:${storyId}`);
  await sw.locator('text=여기까지 되감기').first().waitFor();
  await p.screenshot({ path: `${SHOTS}/16-admin-story.png` });
  await sw.locator('text=여기까지 되감기').first().click();
  await p.locator('.modal >> text=되감기').last().click();
  await sw.locator('text=되감았어요').waitFor();
  assert.equal((await pool.query(`select line_count from app.stories where id = $1`, [storyId])).rows[0].line_count, 1, 'rewound');

  // edit via prompt dialog
  await sw.locator('button:has-text("수정")').first().click();
  await p.locator('.modal textarea').fill('고친 첫 줄');
  await p.locator('.modal >> text=확인').click();
  await sw.locator('text=고쳤어요').waitFor();

  // session survives a reload, #/admin reopens the console; admin.html redirects there
  await p.goto(`${BASE}/admin.html`);
  await win(p, 'admin').waitFor();
  await win(p, 'admin').locator('text=관리자 나가기').click();
  await win(p, 'admin').waitFor({ state: 'detached' });
  assert.ok(!/관리/.test(await p.textContent('#menubar')), 'admin menu gone');

  // the normal 로그아웃 also ends the admin session, even after a reload
  await p.click('#menubar >> text=로그인');
  await p.fill('#lg-name', 'admin@test');
  await p.fill('#lg-sid', 'pw');
  await p.click('.win[data-key="login"] >> text=들어가기');
  await win(p, 'admin').waitFor();
  await p.click('#menubar >> text=로그인');
  await p.fill('#lg-name', '관리자 본인');
  await p.fill('#lg-sid', '2026100099');
  await p.click('.win[data-key="login"] >> text=들어가기');
  await p.click('#menubar >> text=로그아웃');
  await p.waitForSelector('.win[data-key="login"]');
  await p.waitForFunction(() => !Object.keys(localStorage).some(k => k.startsWith('sb-') && k.endsWith('-auth-token')));
  await p.goto(`${BASE}/#/admin`);
  await p.waitForSelector('.win[data-key="login"]');
  await p.click('text=둘러보기 (읽기만)');
  await win(p, 'stories').waitFor();
  assert.equal(await win(p, 'admin').count(), 0, 'no console without the admin login');
  assert.ok(!/관리/.test(await p.textContent('#menubar')));
});

await step('old links: story.html?id= and export.html redirect into 연문회 OS', async () => {
  const b = await newUser('이영희', '2026100002');
  await b.goto(`${BASE}/story.html?id=${storyId}`);
  await b.waitForURL(new RegExp(`/#/story/${storyId}$`));
  await win(b, `story:${storyId}`).waitFor();
  await b.goto(`${BASE}/export.html`);
  await win(b, 'stories').waitFor();
});

await step('remote self-test page passes against local DB (as admin, cleans up)', async () => {
  await pool.query(`update app.settings set max_lines = 20`);
  const p = await newUser('tester', null, { entered: false });
  await adminLogin(p);
  await p.goto(`${BASE}/tests/remote/`);
  await p.click('#run');
  await p.waitForFunction(() => /ALL PASSED|FAILED|ERROR/.test(document.querySelector('#out').textContent), null, { timeout: 60000 });
  const out = await p.textContent('#out');
  assert.match(out, /ALL PASSED/, out);
});

// A finished 4-line story written by four people (straight through the RPCs).
let finishedN = Math.floor(Math.random() * 9000) * 10;   // fresh 학번 per run (story_limit)
async function finishedStory(title) {
  const q = (sql, a) => pool.query(sql, a).then(r => r.rows[0].r);
  const id = (await q(`select public.create_story($1, '첫 번째 줄이에요.', '하나', $2, 'seed') as r`, [title, `2026810${finishedN++}`])).story_id;
  await pool.query(`update app.stories set max_lines = 4 where id = $1`, [id]);
  for (const [i, t] of ['두 번째, 이어서 써요.', '세 번째! 거의 다 왔어요.', '네 번째로 끝.'].entries()) {
    const b = await q(`select public.claim_baton($1, $2, $3, 'seed') as r`, [id, `작가${i + 2}`, `2026800${i + 2}`]);
    await q(`select public.submit_line($1, $2, $3, $4, $5, 'seed', $6) as r`, [id, b.parent_id, t, `작가${i + 2}`, `2026800${i + 2}`, b.token]);
  }
  return id;
}

await step('낭독회: plays every line in the beep voice and ends with the seal and names', async () => {
  const p = await newUser('청중', '2026100099');
  const doneId = await finishedStory('낭독할 이야기');
  await p.goto(`${BASE}/#/story/${doneId}`);
  const storyId = doneId;
  const w = win(p, `story:${storyId}`);
  await w.locator('text=낭독회 열기').click();
  const r = win(p, `read:${storyId}`);
  await r.locator('select[aria-label="빠르기"]').selectOption('2');
  await r.locator('select[aria-label="줄 사이"]').selectOption('1000');
  await r.locator('button[aria-label="재생"]').click();
  await r.locator('.read-cur').filter({ hasText: /\S/ }).waitFor();
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/20-reading.png` });
  await r.locator('.read-cur >> text=끝.').waitFor({ timeout: 30000 });
  assert.match(await r.locator('.read-credits').textContent(), /함께 쓴 사람/);
  assert.equal(await r.locator('.read-segs span.done').count(), 4);
  await p.screenshot({ path: `${SHOTS}/21-reading-end.png` });
  await p.click('.icon[data-route="/stories"]');
  const card = win(p, 'stories').locator('.done-card').first();
  await card.waitFor();
  assert.match(await card.textContent(), /원고지 [\d.]+매 · 4명/);
  await p.screenshot({ path: `${SHOTS}/22-drawer-cards.png` });
});

await step('도장: stamp from the 속성 window, counts, toggle off, pad and scroll ticks', async () => {
  const p = await newUser('도장꾼', '2026100777');
  const storyId = await finishedStory('도장 이야기');
  await p.goto(`${BASE}/#/story/${storyId}`);
  const w = win(p, `story:${storyId}`);
  await w.locator('.line .who').first().click();
  const box = p.locator('.props .stamp-buttons');
  await box.waitFor();
  await box.locator('.stamp-btn').nth(1).click();
  await p.locator('.props .stamp-btn.is-mine >> text=재밌어요').waitFor();
  assert.match(await box.locator('.stamp-btn').nth(1).textContent(), /재밌어요 1/);
  await box.locator('.stamp-btn').nth(0).click();
  await p.locator('.props .stamp-btn.is-mine').nth(1).waitFor();
  await p.waitForTimeout(500);
  if (process.env.DEBUGSTAMP) console.log('DEBUG', await p.evaluate(() => { const e = document.elementFromPoint(500, 400); return e.outerHTML.slice(0, 300) + ' | ' + e.parentElement?.className + ' | ' + getComputedStyle(e).width; }));
  await p.screenshot({ path: `${SHOTS}/23-stamp-props.png` });
  await p.keyboard.press('Escape');
  await w.locator('.line').first().locator('.stamp-mark').nth(1).waitFor();
  // another person sees the pad but no "mine"
  const q = await newUser('구경꾼', '2026100778');
  await q.goto(`${BASE}/#/story/${storyId}`);
  const w2 = win(q, `story:${storyId}`);
  await w2.locator('.line').first().locator('.stamp-mark').nth(1).waitFor();
  await w2.locator('.line .who').first().click();
  assert.equal(await q.locator('.props .stamp-btn.is-mine').count(), 0);
  assert.match(await q.locator('.props .stamp-buttons').textContent(), /잘했어요 1.*재밌어요 1/);
  // toggle off
  await w.locator('.line .who').first().click();
  await p.locator('.props .stamp-btn').nth(1).click();
  await p.waitForFunction(() => /재밌어요 0/.test(document.querySelector('.props .stamp-buttons')?.textContent ?? ''));
  const n = (await pool.query(`select count(*)::int as n from app.stamps where student_id = '2026100777'`)).rows[0].n;
  assert.equal(n, 1);
});

await step('꽉 채웠어요: a line of exactly the limit gets the 원고지 mark', async () => {
  const text = '가'.repeat(99) + '.';
  const id = (await pool.query(`select public.create_story('꽉', $1, '꽉작가', '20267000', 'seed') as r`, [text])).rows[0].r.story_id;
  const p = await newUser('꽉독자', '2026100701');
  await p.goto(`${BASE}/#/story/${id}`);
  const w = win(p, `story:${id}`);
  await w.locator('.full-mark').waitFor();
  await w.locator('.line .who').first().click();
  assert.match(await p.locator('.props').textContent(), /100 \/ 100자 꽉!/);
});

await step('고양이: pet → 야옹 with the shared count; admin can turn it off', async () => {
  const p = await newUser('집사', '2026100801');
  await p.goto(`${BASE}/`);
  const cat = p.locator('.cat');
  await cat.waitFor();
  assert.equal(await cat.getAttribute('title'), '문냥이');
  const before = Number((await pool.query(`select value from app.counters where key='cat_pets'`)).rows[0].value);
  await cat.click({ force: true });
  await p.locator('.cat-say >> text=야옹!').waitFor();
  assert.match(await p.locator('.cat-say').textContent(), new RegExp(`\\(${before + 1}\\)`));
  await p.screenshot({ path: `${SHOTS}/24-cat-pet.png` });
  await pool.query(`update app.settings set extras = extras || '{"cat": false}'`);
  await p.reload();
  await p.waitForSelector('.win[data-key="stories"]');
  await p.waitForTimeout(500);
  assert.ok(await cat.isHidden());
  await pool.query(`update app.settings set extras = extras - 'cat'`);
});

await step('바탕화면: right-click menu, about window, 접어 두기 tray, memo /정리, sticky note', async () => {
  const p = await newUser('바탕', '2026100802');
  await p.goto(`${BASE}/`);
  await p.waitForSelector('.win[data-key="stories"]');
  await p.locator('.sticky').waitFor();
  await p.mouse.click(900, 700, { button: 'right' });
  await p.locator('.ctx >> text=창 정리하기').waitFor();
  await p.screenshot({ path: `${SHOTS}/25-context-menu.png` });
  await p.locator('.ctx >> text=이 컴퓨터에 관하여').click();
  await win(p, 'about').locator('text=기억 장치').waitFor();
  assert.match(await win(p, 'about').textContent(), /문냥이 1마리/);
  await p.screenshot({ path: `${SHOTS}/26-about.png` });
  await win(p, 'about').locator('.win-close').click();
  await win(p, 'stories').locator('.win-min').click();
  await p.locator('.tray-btn >> text=이야기 서랍').waitFor();
  assert.ok(await win(p, 'stories').isHidden());
  await p.screenshot({ path: `${SHOTS}/27-tray.png` });
  await p.locator('.tray-btn').click();
  await win(p, 'stories').waitFor();
  assert.equal(await p.locator('.tray-btn').count(), 0);
  await p.goto(`${BASE}/#/memo`);
  const m = win(p, 'memo');
  await m.locator('textarea').fill('다음 차례에 쓸 것');
  await m.locator('textarea').press('Enter');
  await m.locator('textarea').type('/정리');
  await m.locator('textarea').press('Enter');
  assert.equal(await m.locator('textarea').inputValue(), '다음 차례에 쓸 것\n');
  await p.reload();
  await p.goto(`${BASE}/#/memo`);
  assert.match(await win(p, 'memo').locator('textarea').inputValue(), /다음 차례에 쓸 것/);
});

await step('화면 보호기: starts on demand, the waking key is swallowed', async () => {
  const p = await newUser('졸린이', '2026100803');
  await p.goto(`${BASE}/`);
  await p.waitForSelector('.win[data-key="stories"]');
  await p.mouse.click(900, 700, { button: 'right' });
  await p.locator('.ctx >> text=화면 보호기 지금 켜기').click();
  await p.locator('.saver[data-kind="typing"]').waitFor({ timeout: 10000 });
  await p.locator('.saver-meta:not([hidden])').waitFor({ timeout: 20000 });
  await p.screenshot({ path: `${SHOTS}/28-saver-typing.png` });
  assert.ok(await p.locator('.cat').isHidden());
  // moving the mouse or scrolling doesn't end it — you can sit and watch
  await p.mouse.move(300, 300); await p.mouse.move(700, 500, { steps: 8 }); await p.mouse.wheel(0, 300);
  await p.waitForTimeout(600);
  assert.equal(await p.locator('.saver').count(), 1, 'still showing after mouse movement');
  // a click ends it, and doesn't press whatever was underneath
  await p.mouse.click(640, 400);
  await p.waitForSelector('.saver', { state: 'detached' });
  await p.locator('.cat').waitFor();
  // so does a key
  await p.mouse.click(900, 700, { button: 'right' });
  await p.locator('.ctx >> text=화면 보호기 지금 켜기').click();
  await p.locator('.saver').waitFor({ timeout: 10000 });
  await p.keyboard.press('a');
  await p.waitForSelector('.saver', { state: 'detached' });
});

await step('호박색 단말기 and 낮과 밤 switch', async () => {
  const p = await newUser('밤손님', '2026100804');
  await p.goto(`${BASE}/#/story/${storyId}`);
  await p.waitForSelector(`.win[data-key="story:${storyId}"]`);
  await p.locator('.phase-ico').click();            // auto -> 늘 낮
  await p.locator('.phase-ico').click();            // -> 늘 밤
  await p.waitForFunction(() => document.body.classList.contains('phase-night'));
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${SHOTS}/29-night.png` });
  await p.locator('.phase-ico').click();            // -> 자동
  for (const k of ['KeyG', 'KeyH', 'KeyQ', 'KeyK', 'KeyR']) await p.keyboard.press(k);
  await p.waitForFunction(() => document.body.classList.contains('amber'));
  await p.locator('.amber-toast').waitFor();
  await p.screenshot({ path: `${SHOTS}/30-amber.png` });
  await p.locator('.amber-toast >> text=돌아가기').click();
  assert.ok(!(await p.evaluate(() => document.body.classList.contains('amber'))));
});

await step('관리 · 부가 기능: inner tabs save switches and the deadline', async () => {
  const p = await newUser('운영진', null, { entered: false });
  await adminLogin(p);
  const w = win(p, 'admin');
  await w.locator('.tabs >> text=부가 기능').click();
  await w.locator('.extra-tabs >> text=고양이').click();
  const nameRow = w.locator('.extra-row', { hasText: '마우스를 올리면 보여요' });
  await nameRow.waitFor();
  const name = nameRow.locator('input');
  await name.fill('백냥이');
  await name.press('Tab');
  await w.locator('text=이름 저장했어요').waitFor();
  await p.screenshot({ path: `${SHOTS}/31-admin-extras.png` });
  await w.locator('.extra-tabs >> text=바탕화면').click();
  const dl = w.locator('.extra-row:has-text("마감 일시") input');
  assert.equal(await dl.inputValue(), '2026-11-23T00:00');
  await dl.fill('2026-11-30T00:00');
  await dl.press('Tab');
  await w.locator('text=마감 일시 (서울) 저장했어요').waitFor();
  const x = (await pool.query(`select extras from app.settings`)).rows[0].extras;
  assert.equal(x.cat_name, '백냥이'); assert.equal(x.deadline, '2026-11-30T00:00:00+09:00');
  // 설정: 새 이야기 제목 필수 lives in extras but sits next to 새 이야기 허용
  await w.locator('.tabs >> text=설정').click();
  const req = w.locator('label.check:has-text("새 이야기 제목 필수") input');
  assert.ok(await req.isChecked());
  await req.uncheck();
  await w.locator('button:has-text("저장")').click();
  await w.locator('text=설정을 저장했어요').waitFor();
  assert.equal((await pool.query(`select extras->>'title_required' v from app.settings`)).rows[0].v, 'false');
  await pool.query(`update app.settings set extras = '{}'`);
});

await step('mobile: stamp sheet buttons, cat on the dock, D-n deadline', async () => {
  const p = await newUser('폰도장', '2026100805', { mobile: true });
  const storyId = await finishedStory('폰 도장 이야기');
  await p.goto(`${BASE}/#/story/${storyId}`);
  const w = win(p, `story:${storyId}`);
  await w.locator('.story-head h3').waitFor();
  assert.equal(await w.locator('.win-scroll').evaluate(el => el.scrollTop), 0, 'finished story opens at its title');
  const hb = await w.locator('.story-head').boundingBox(), sb = await w.locator('.win-scroll').boundingBox();
  assert.ok(hb.y >= sb.y - 1, 'head not clipped');
  await p.screenshot({ path: `${SHOTS}/34-mobile-finished-top.png` });
  await w.locator('.line .who').first().tap();
  await p.locator('.props.sheet .stamp-btn').first().waitFor();
  await p.screenshot({ path: `${SHOTS}/32-mobile-stamp-sheet.png` });
  await p.locator('.props.sheet .stamp-btn').nth(2).tap();
  await p.locator('.props.sheet .stamp-btn.is-mine').waitFor();
  await p.keyboard.press('Escape');
  assert.match(await p.locator('.menubar .deadline').textContent(), /^마감 D-(\d+|day)$/);
  await p.locator('.cat').waitFor();
  await p.screenshot({ path: `${SHOTS}/33-mobile-story.png` });
});

await step('logo opens 이 컴퓨터에 관하여; a new story needs a title; sounds play without errors', async () => {
  const p = await newUser('제목없음', '2026100807');
  await p.goto(`${BASE}/`);
  await win(p, 'stories').waitFor();
  await p.click('.menubar .logo');
  await win(p, 'about').locator('text=연문회 OS').first().waitFor();
  await p.goto(`${BASE}/#/new`);
  await p.waitForSelector('#ns-text');
  assert.equal((await p.textContent('label[for="ns-title"]')).trim(), '제목');
  await p.fill('#ns-title', '');
  await p.fill('#ns-text', '제목 없이 시작해 볼까요.');
  await p.click('text=시작하기');
  await win(p, 'new').locator('text=제목을 붙여 주세요.').waitFor();
  await win(p, 'new').locator('text=닫기').click();
  // every sound and the reading voice render in the page without throwing
  const r = await p.evaluate(async () => {
    const { makeSynth, speakerFor, voicePlan } = await import('./js/extras/synth.js');
    const ac = new OfflineAudioContext(1, 44100 * 3, 44100), s = makeSynth(ac);
    s.names.forEach((n, i) => s.play(n, 0.01 + i * 0.05, { ch: 'a' }));
    const sp = speakerFor('x'); voicePlan('안녕하세요? 반가워요!', sp).forEach((n, i) => s.speak(0.02 + i * 0.08, n, sp, 1));
    const d = (await ac.startRendering()).getChannelData(0);
    let peak = 0; for (const x of d) peak = Math.max(peak, Math.abs(x));
    return { peak, names: s.names.length };
  });
  assert.ok(r.peak > 0.05 && r.peak < 1, `sound level ${r.peak}`);
});

await step('mobile tour: drawer cards, finished story, 낭독회, help, about, memo, sky, amber, saver', async () => {
  const p = await newUser('폰구경', '2026100806', { mobile: true });
  const id = await finishedStory('폰으로 보는 이야기');
  const shot = (n) => p.screenshot({ path: `${SHOTS}/m-${n}.png` });
  await p.goto(`${BASE}/`);
  await win(p, 'stories').locator('.done-card').first().waitFor();
  await shot('01-drawer');
  await p.goto(`${BASE}/#/story/${id}`);
  await win(p, `story:${id}`).locator('.story-head h3').waitFor();
  await win(p, `story:${id}`).locator('.record summary').click();
  await win(p, `story:${id}`).locator('.win-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot('02-record-open');
  await win(p, `story:${id}`).locator('text=낭독회 열기').click();
  const r = win(p, `read:${id}`);
  await r.locator('select[aria-label="빠르기"]').selectOption('2');
  await r.locator('button[aria-label="재생"]').click();
  await r.locator('.read-cur').filter({ hasText: /\S/ }).waitFor();
  await p.waitForTimeout(900);
  await shot('03-reading');
  for (const route of ['help', 'about', 'memo']) {
    await p.goto(`${BASE}/#/${route}`);
    await win(p, route).waitFor();
    await p.waitForTimeout(400);
    await shot(`04-${route}`);
  }
  await p.locator('#dock >> text=서랍').click();
  await p.evaluate(() => { localStorage.setItem('rn.daynight', 'day'); });
  await p.reload(); await win(p, 'stories').waitFor();
  await shot('05-day');
  await p.evaluate(() => { localStorage.setItem('rn.daynight', 'night'); });
  await p.reload(); await win(p, 'stories').waitFor();
  await shot('06-night');
  for (let i = 0; i < 5; i++) await p.locator('.menubar .logo').tap();
  await p.waitForFunction(() => document.body.classList.contains('amber'));
  await shot('07-amber');
  await p.locator('.amber-toast >> text=돌아가기').tap();
  await p.evaluate(async () => { const m = await import('./js/extras/extras.js'); m.bus.emit('saver-now', {}); });
  await p.locator('.saver').waitFor({ timeout: 10000 });
  await p.waitForTimeout(2500);
  await shot('08-saver');
});

await step('why you cannot write is shown before pressing 이어 쓰기 (own limit, deadline)', async () => {
  const id = (await pool.query(`select public.create_story('내가 시작한 이야기', '첫 줄.', '시작한이', '2026100809', 'seed') as r`)).rows[0].r.story_id;
  const p = await newUser('시작한이', '2026100809');
  await p.goto(`${BASE}/#/story/${id}`);
  const w = win(p, `story:${id}`);
  await w.locator('.win-foot .notice', { hasText: '한 사람당' }).waitFor();
  assert.ok(await w.locator('button:text-is("이어 쓰기")').isDisabled());
  await pool.query(`update app.settings set extras = extras || '{"deadline_closes": true, "deadline": "2020-01-01T00:00:00+09:00"}'`);
  const q = await newUser('늦은이', '2026100810');
  await q.goto(`${BASE}/#/new`);
  await win(q, 'new').locator('text=마감 시간이 지나').waitFor();
  assert.ok(await win(q, 'new').locator('button[type=submit]').isDisabled());
  await q.waitForFunction(() => /마감됐어요/.test(document.querySelector('.menubar .deadline')?.textContent ?? ''));
  await pool.query(`update app.settings set extras = extras - 'deadline_closes' - 'deadline'`);
});

await step('내가 쓴 줄 from my name; 원고지로 인쇄; crash reports reach 관리 · 기록', async () => {
  const id = await finishedStory('원고지 이야기');
  // 작가2 wrote line 2 of every finishedStory (see the helper)
  const p = await newUser('작가2', '20268002');
  await p.goto(`${BASE}/#/story/${id}`);
  const w = win(p, `story:${id}`);
  await w.locator('.story-head h3').waitFor();
  // 원고지: stub the print dialog, then look at the sheets the page laid out
  await p.evaluate(() => { window.print = () => { window.__printed = (window.__printed ?? 0) + 1; }; });
  await w.locator('button:text-is("원고지로 인쇄")').click();
  await p.waitForFunction(() => window.__printed === 1);
  const sheet = await p.evaluate(() => ({
    sheets: document.querySelectorAll('.print-sheets .ms-sheet').length,
    cells: document.querySelectorAll('.print-sheets .ms-sheet:first-child .ms-cell').length,
    text: [...document.querySelectorAll('.print-sheets .ms-cell')].map(c => c.textContent).join(''),
    seal: !!document.querySelector('.print-sheets .ms-seal svg'),
  }));
  assert.equal(sheet.cells, 200, 'a 200자 원고지 sheet');
  assert.ok(sheet.sheets >= 1 && sheet.seal);
  assert.match(sheet.text, /원고지이야기/); assert.match(sheet.text, /두번째,이어서써요\./);
  await p.emulateMedia({ media: 'print' });
  await p.screenshot({ path: `${SHOTS}/35-print-sheet.png`, fullPage: true });
  await p.emulateMedia({ media: 'screen' });
  await p.evaluate(() => dispatchEvent(new Event('afterprint')));
  assert.equal(await p.locator('.print-sheets').count(), 0, 'cleaned up after printing');
  // 내가 쓴 줄
  await p.locator('.menubar .menu-name').click();
  const m = win(p, 'mine');
  await m.locator('.mine-lines li', { hasText: '두 번째, 이어서 써요.' }).first().waitFor();
  assert.match(await m.locator('.win-bar').textContent(), /줄 \d+개 · 이야기 \d+편/);
  await p.screenshot({ path: `${SHOTS}/36-mine.png` });
  // crash report
  await pool.query('delete from app.client_errors');
  await p.evaluate(() => setTimeout(() => { throw new Error('e2e boom'); }));
  await p.waitForTimeout(800);
  const r = (await pool.query(`select message, source, version from app.client_errors`)).rows;
  assert.equal(r.length, 1); assert.match(r[0].message, /e2e boom/); assert.ok(r[0].version, 'tagged with the deployed version');
  errors.splice(errors.findIndex(e => e.includes('e2e boom')), 1);          // that one was on purpose
});

// Accessibility: axe-core on the main screens; serious / critical WCAG A+AA problems fail the run.
const AXE = fs.readFileSync(new URL('./node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
async function axe(p, label) {
  await p.addScriptTag({ content: AXE });
  const r = await p.evaluate(async () => (await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  })).violations.filter(v => ['serious', 'critical'].includes(v.impact))
    .map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}${v.nodes.length > 3 ? ` +${v.nodes.length - 3}` : ''}`));
  return r.map(x => `[${label}] ${x}`);
}

await step('accessibility: no serious axe-core problems on the main screens (desktop + phone)', async () => {
  const found = [];
  const g = await newUser('a11y', null, { entered: false });
  await g.goto(`${BASE}/`); await g.waitForSelector('.win[data-key="login"]'); await g.waitForTimeout(400);
  found.push(...await axe(g, 'login'));
  const id = await finishedStory('접근성 이야기');
  const p = await newUser('접근성', '2026100811');
  await p.goto(`${BASE}/#/story/${id}`); await win(p, `story:${id}`).locator('.story-head h3').waitFor(); await p.waitForTimeout(400);
  found.push(...await axe(p, 'finished story + drawer'));
  await p.goto(`${BASE}/#/help`); await win(p, 'help').waitFor(); found.push(...await axe(p, 'help'));
  await p.goto(`${BASE}/#/mine`); await win(p, 'mine').waitFor(); found.push(...await axe(p, 'mine'));
  await p.goto(`${BASE}/#/guestbook`); await win(p, 'guestbook').waitFor(); found.push(...await axe(p, 'guestbook'));
  const m = await newUser('폰접근성', '2026100812', { mobile: true });
  await m.goto(`${BASE}/#/story/${id}`); await win(m, `story:${id}`).locator('.story-head h3').waitFor(); await m.waitForTimeout(400);
  found.push(...await axe(m, 'phone story'));
  if (found.length) console.log(found.join('\n'));
  assert.deepEqual(found, []);
});

await step('versioned files: every module and stylesheet loads once, with its ?v= hash', async () => {
  const p = await newUser('버전', '2026100808');
  const urls = [];
  p.on('request', r => { const u = new URL(r.url()); if (u.origin === BASE && /\.(js|css)$/.test(u.pathname)) urls.push(u.pathname + u.search); });
  await p.goto(`${BASE}/`);
  await win(p, 'stories').waitFor();
  await p.waitForTimeout(500);
  const bare = urls.filter(u => !u.includes('?v=') && !u.includes('/vendor/'));
  assert.deepEqual(bare, [], 'loaded without a version');
  assert.equal(new Set(urls).size, urls.length, 'nothing fetched twice');
  assert.ok(urls.filter(u => u.endsWith('.js') || u.includes('.js?')).length >= 26);
});

await step('sounds: typing in every text field, window open / minimize / restore / close, menus, dialogs', async () => {
  const p = await newUser('소리', '2026100813');
  await p.addInitScript(() => { localStorage.setItem('rn.sound', '1'); localStorage.setItem('rn.debugSounds', '1'); });
  await p.goto(`${BASE}/`);
  await win(p, 'stories').waitFor();
  const heard = () => p.evaluate(() => { const s = window.__rnSounds ?? []; window.__rnSounds = []; return s; });
  await heard();
  await p.click('.icon[data-route="/guestbook"]');
  await win(p, 'guestbook').locator('textarea').waitFor();
  await win(p, 'guestbook').locator('textarea').pressSequentially('안녕', { delay: 80 });
  let s = await heard();
  assert.ok(s.includes('open'), `guestbook opened with a sound: ${s}`);
  assert.ok(s.filter(x => x === 'key').length >= 2, `typing in 방명록: ${s}`);
  await p.goto(`${BASE}/#/memo`); await win(p, 'memo').locator('textarea').waitFor(); await heard();
  await win(p, 'memo').locator('textarea').pressSequentially('메모', { delay: 80 });
  assert.ok((await heard()).includes('key'), 'typing in 메모장');
  await win(p, 'memo').locator('.win-min').click();
  assert.deepEqual(await heard(), ['minimize']);
  await p.locator('.tray-btn').first().click();
  assert.ok((await heard()).includes('restore'));
  await win(p, 'memo').locator('.win-close').click();
  assert.ok((await heard()).includes('close'));
  await win(p, 'guestbook').locator('.win-close').click();
  await p.waitForTimeout(150); await heard();
  await p.mouse.click(1000, 600, { button: 'right' });
  await p.locator('.ctx').waitFor();
  assert.ok((await heard()).includes('menu'));
  await p.locator('.ctx >> text=이 컴퓨터에 관하여').click();
  await win(p, 'about').waitFor();
  s = await heard();
  assert.ok(s.includes('select') && s.includes('open'), `menu pick opens a window: ${s}`);
  // logging out closes every window: one close sound, not one per window
  await p.locator('.menubar >> text=로그아웃').click();
  if (await p.locator('.modal').count()) { assert.ok((await heard()).includes('alert')); await p.locator('.modal >> text=확인').click(); }
  await p.waitForSelector('.win[data-key="login"]');
  s = await heard();
  assert.ok(s.filter(x => x === 'close').length <= 1, `one close sound at log-out: ${s}`);
});

await step('little touches: 학생회관, zoom outlines, "no" shake, type-in lines, ticker, milestones, cat watching', async () => {
  const q = (sql, a) => pool.query(sql, a).then(r => r.rows[0].r);
  let k = 0;
  const add = async (id, t) => {
    const sid = `20265${String(k++).padStart(5, '0')}`;
    const b = await q(`select public.claim_baton($1, $2, $3, 'seed') as r`, [id, `손님${k}`, sid]);
    return q(`select public.submit_line($1, $2, $3, $4, $5, 'seed', $6) as r`, [id, b.parent_id, t, `손님${k}`, sid, b.token]);
  };
  const make = async (title, lines, max) => {
    const id = (await q(`select public.create_story($1, $2, '첫줄', $3, 'seed') as r`, [title, lines[0], `20264${String(k++).padStart(5, '0')}`])).story_id;
    await pool.query('update app.stories set max_lines = $2 where id = $1', [id, max]);
    for (const t of lines.slice(1)) await add(id, t);
    return id;
  };
  const half = await make('반환점 이야기', ['하나.', '둘.', '셋.'], 8);
  const last = await make('마지막 한 줄 이야기', ['처음이자', '거의 끝'], 3);
  const p = await newUser('생기', '2026100814');
  await p.addInitScript(() => { localStorage.setItem('rn.sound', '1'); localStorage.setItem('rn.debugSounds', '1'); localStorage.setItem('rn.daynight', 'night'); });
  await p.goto(`${BASE}/`);
  await win(p, 'stories').waitFor();
  // the building behind the icons, lit windows at night (the club room always), autumn trees
  assert.equal(await p.locator('.desk-skyline canvas.sk').count(), 1);
  assert.ok(Number(await p.locator('.desk-skyline').getAttribute('data-lit')) >= 1, 'the club room is lit at night');
  const cls = await p.evaluate(() => document.body.className);
  for (const c of ['fx-press', 'fx-cursor', 'season-autumn', 'phase-night']) assert.ok(cls.includes(c), `${c} in ${cls}`);
  // a window zooms out of its icon
  await p.click('.icon[data-route="/guestbook"]');
  await p.locator('.zoom-rect').first().waitFor({ state: 'attached', timeout: 1000 });
  await win(p, 'guestbook').locator('.win-close').click();
  // the last empty line glows
  await p.goto(`${BASE}/#/story/${last}`);
  await win(p, `story:${last}`).locator('.line.last-slot >> text=마지막 한 줄이 남았어요').waitFor();
  // someone holds it: pressing 이어 쓰기 shakes the window "no" with the error sound
  await q(`select public.claim_baton($1, '다른 사람', '2026100899', 'seed') as r`, [last]);
  await p.evaluate(() => { window.__rnSounds = []; });
  await win(p, `story:${last}`).locator('button:text-is("이어 쓰기")').click();
  await p.waitForFunction((key) => document.querySelector(`.win[data-key="${key}"]`)?.classList.contains('no'), `story:${last}`, { timeout: 3000 });
  assert.ok((await p.evaluate(() => window.__rnSounds)).includes('error'));
  // another person's line arrives: it types itself in, the window says 절반 왔어요!, the menu bar ticker passes it on
  await p.goto(`${BASE}/#/story/${half}`);
  const w = win(p, `story:${half}`);
  await w.locator('.line').nth(2).waitFor();
  await p.evaluate(() => { window.__rnSounds = []; });
  await p.waitForTimeout(1500);                       // the window has learned its starting version
  await add(half, '넷, 여기서 반을 돌아요.');
  await w.locator('.line.typing-in').waitFor({ timeout: 30000 });
  await w.locator('.milestone >> text=절반 왔어요!').waitFor({ timeout: 3000 });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${SHOTS}/30-little-touches.png` });
  await w.locator('.line:not(.typing-in) >> text=넷, 여기서 반을 돌아요.').waitFor({ timeout: 5000 });
  assert.ok((await p.evaluate(() => window.__rnSounds)).includes('ret'), 'a carriage return at the end');
  await p.locator('.ticker:not([hidden]) >> text=반환점 이야기').waitFor({ timeout: 5000 });
  // the cat comes to watch when I type
  await w.locator('button:text-is("이어 쓰기")').click();
  const ta = w.locator('textarea');
  await ta.waitFor();
  const before = await p.locator('.cat').evaluate(e => e.offsetLeft);
  await ta.pressSequentially('고양이가 보고 있다', { delay: 60 });
  await p.waitForTimeout(3500);
  const box = await w.boundingBox();
  const catX = await p.locator('.cat').evaluate(e => e.offsetLeft + e.offsetWidth / 2);
  assert.ok(catX > box.x - 40 && catX < box.x + box.width + 40, `the cat came under the window (${before} → ${catX}, window ${box.x}..${box.x + box.width})`);
  await w.locator('button:text-is("취소")').click();
  // 첫눈: after the admin's date the trees go bare, roofs get snow, flakes instead of leaves
  await pool.query(`update app.settings set extras = extras || '{"snow_from": "2020-01-01T00:00:00+09:00"}'::jsonb`);
  await p.reload();
  await win(p, 'stories').waitFor();
  await p.waitForFunction(() => document.body.classList.contains('season-winter'));
  await pool.query(`update app.settings set extras = extras - 'snow_from'`);
});

await step('sound turns itself off 5 minutes after the last screen saver; a note offers to turn it back on', async () => {
  const p = await newUser('졸음', '2026100815');
  await p.clock.install();
  await p.addInitScript(() => { localStorage.setItem('rn.sound', '1'); });
  await p.goto(`${BASE}/`);
  await win(p, 'stories').waitFor();
  assert.equal(await p.locator('.sound-btn').getAttribute('aria-pressed'), 'true');
  await p.clock.runFor(14 * 60e3);                    // savers end at 10 min (고양이 낮잠): still on at 14
  assert.equal(await p.evaluate(() => localStorage.getItem('rn.sound')), '1', 'still on at 14 min');
  await p.clock.runFor(2 * 60e3);
  assert.equal(await p.evaluate(() => localStorage.getItem('rn.sound')), '0', 'sound off after 15 min away');
  await p.keyboard.press('Shift');                    // wakes the screen saver (swallowed) and says "I'm back"
  await p.locator('.doze-note >> text=오래 자리를 비워서 소리를 껐어요.').waitFor();
  await p.clock.runFor(500);                          // (the waking key's click guard lasts 0.4 s)
  assert.equal(await p.locator('.sound-btn').getAttribute('aria-pressed'), 'false');
  await p.locator('.doze-note button:text-is("다시 켜기")').click();
  assert.equal(await p.evaluate(() => localStorage.getItem('rn.sound')), '1', 'turned back on');
  assert.equal(await p.locator('.sound-btn').getAttribute('aria-pressed'), 'true');
});

// Last on purpose: it wipes the database.
await step('관리 · 초기화: one counter, then everything (with a backup download first)', async () => {
  await finishedStory('지워질 이야기');
  await pool.query(`update app.counters set value = 7 where key = 'cat_pets'`);
  const p = await newUser('초기화', null, { entered: false });
  await adminLogin(p);
  const w = win(p, 'admin');
  await w.locator('.tabs >> text=초기화').click();
  const catRow = w.locator('.reset-row', { hasText: '고양이 쓰다듬기 횟수' });
  await catRow.locator('text=지금 7번').waitFor();
  await catRow.locator('button').click();
  await p.locator('.modal >> text=확인').click();
  await w.locator('text=고양이 쓰다듬기 횟수 0으로 — 끝났어요.').waitFor();
  assert.equal(Number((await pool.query(`select value from app.counters where key = 'cat_pets'`)).rows[0].value), 0);
  await p.screenshot({ path: `${SHOTS}/37-admin-reset.png` });
  // 전부 초기화: wrong word does nothing; '지우기' downloads a backup, then wipes
  await w.locator('.reset-all button').click();
  await p.locator('.modal input').fill('네');
  await p.locator('.modal >> text=지우기').last().click();
  await w.locator("text='지우기'라고 적어야 지워져요.").waitFor();
  assert.ok(Number((await pool.query('select count(*) from app.stories')).rows[0].count) > 0);
  await w.locator('.reset-all button').click();
  await p.locator('.modal input').fill('지우기');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('.modal >> text=지우기').last().click()]);
  assert.match(dl.suggestedFilename(), /relay-novel-backup-.*\.json/);
  await w.locator('text=전부 초기화 — 끝났어요.').waitFor();
  const left = (await pool.query(`select (select count(*) from app.stories) s, (select count(*) from app.lines) l,
    (select count(*) from app.stamps) st, (select count(*) from app.guestbook) g, (select count(*) from app.client_errors) e,
    (select sum(value) from app.counters) c`)).rows[0];
  assert.deepEqual(Object.values(left).map(Number), [0, 0, 0, 0, 0, 0]);
  await p.locator('.icon[data-route="/stories"]').click();
  await win(p, 'stories').locator('text=아직 이야기가 없어요').waitFor();
});

await step('no page errors', async () => { assert.deepEqual(errors, []); });

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
await browser.close(); server.close(); await pool.end();
