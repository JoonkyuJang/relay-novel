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
      keys.map(k => (args[k] !== null && typeof args[k] === 'object') ? JSON.stringify(args[k]) : args[k]));
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
  await win(p, `story:${storyId}`).locator('text=이어 쓰기').click();
  await p.waitForSelector('text=1줄까지 쓸 수 있어요');
});

await step('deep link + writer B: claim, counter, Enter submits -> line 2', async () => {
  const b = await newUser('이영희', '2026100002');
  await b.goto(`${BASE}/#/story/${storyId}`);
  const w = win(b, `story:${storyId}`);
  await w.waitFor();
  assert.equal(await b.locator('.win[data-key="stories"]').count(), 1, 'drawer open behind');
  assert.match(await w.textContent(), /이영희 님으로 써요/);
  await w.locator('text=이어 쓰기').click();
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
  await wd.locator('text=이어 쓰기').click();
  await wd.locator('textarea').waitFor();
  const c = await newUser('박민수', '2026100003');
  await c.goto(`${BASE}/#/story/${storyId}`);
  const wc = win(c, `story:${storyId}`);
  await wc.locator('.line.pending').waitFor();
  assert.match(await wc.textContent(), /다른 사람이 쓰는 중이에요/);
  await wc.locator('text=이어 쓰기').click();
  await wc.locator('text=다른 사람이 이어 쓰는 중이에요').waitFor();
  await pool.query(`update app.stories set baton_expires_at = now() - interval '1 s' where baton_name = '최지우'`);
  await wc.locator('text=이어 쓰기').click();
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
  await wd.locator('text=이어 쓰기').waitFor();
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
  await w.locator('text=이어 쓰기').click();
  await w.locator('text=마지막 줄이에요').waitFor();
  await w.locator('textarea').fill('그리고 마을은 다시 조용해졌다.');
  await w.locator('text=올리기').click();
  await w.locator('.stamp').waitFor();
  assert.match(await w.textContent(), /이야기가 완결되었습니다/);
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
  await w.locator('text=이어 쓰기').waitFor();
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
  await b.click('#menubar >> text=도움말');
  await win(b, 'help').waitFor();
  assert.ok(await win(b, 'help').evaluate(el => el.classList.contains('is-active')));
  assert.match(b.url(), /#\/help$/);
  await win(b, 'stories').locator('.win-foot').click({ position: { x: 8, y: 8 } });
  assert.ok(await win(b, 'stories').evaluate(el => el.classList.contains('is-active')));
  assert.match(b.url(), /#\/stories$/);
  await win(b, 'help').locator('.win-close').click();
  assert.equal(await win(b, 'help').count(), 0);
  await b.screenshot({ path: `${SHOTS}/13-desktop-dragged.png` });
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
  await w.locator('text=이어 쓰기').click();
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

await step('no page errors', async () => { assert.deepEqual(errors, []); });

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
await browser.close(); server.close(); await pool.end();
