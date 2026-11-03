// Browser end-to-end test of the barebones UI against the LOCAL Postgres.
// Supabase HTTP calls are intercepted and executed the way PostgREST would
// (role anon, or authenticated with the JWT "sub"). Realtime is not emulated,
// so pages fall back to polling / manual refresh.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SB = 'https://xuuoyzhksctpzxcylhwe.supabase.co';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const pool = new pg.Pool({ host: '/var/lib/postgresql/rn', port: 5433, user: 'postgres', database: 'rn' });
const SHOTS = process.env.SHOTS ?? '/tmp/rn-shots';
fs.mkdirSync(SHOTS, { recursive: true });

// ---- static server
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
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
async function newUser(name, sid) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.route(`${SB}/**`, handle);
  await ctx.routeWebSocket?.(/supabase\.co/, ws => ws.close?.());
  await ctx.addInitScript(([n, s]) => { localStorage.setItem('rn.name', n); localStorage.setItem('rn.sid', s); }, [name, sid]);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error(`[${name}] pageerror`, e.message));
  page.on('dialog', d => d.accept());
  return page;
}

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1; }
}

console.log('relay-novel e2e (local)');
await pool.query(`insert into app.admins(user_id) values ($1) on conflict do nothing`, [ADMIN]);

const a = await newUser('김철수', '2026100001');
const b = await newUser('이영희', '2026100002');
const c = await newUser('박민수', '2026100003');
let storyUrl;

await step('index: create a story -> redirected to its page', async () => {
  await a.goto(`${BASE}/`);
  await a.fill('input[name=title]', 'E2E 이야기');
  await a.fill('textarea[name=text]', '옛날 옛적에 작은 마을이 있었다.');
  await a.click('form#create button[type=submit]');
  await a.waitForURL(/story\.html\?id=/);
  storyUrl = a.url();
  await a.waitForSelector('ol.lines li');
  assert.equal(await a.locator('ol.lines li').count(), 1);
  assert.match(await a.textContent('#title'), /E2E 이야기/);
});

await step('starter cannot continue own story (1 line per person)', async () => {
  await a.click('text=이어 쓰기');
  await a.waitForFunction(() => document.querySelector('#composerMsg')?.textContent.length > 0);
  assert.match(await a.textContent('#composerMsg'), /1줄까지/);
});

await step('writer B: claim, counter, final warning absent, submit -> line 2', async () => {
  await b.goto(storyUrl);
  await b.click('text=이어 쓰기');
  await b.waitForSelector('#text');
  assert.match(await b.textContent('#composer'), /2번째 줄/);
  await b.fill('#text', '마을에는 이상한 우체통이 하나 있었다.');
  assert.match(await b.textContent('.counter'), /^21 \/ 100$/);
  await b.click('#submitBtn');
  await b.waitForFunction(() => document.querySelectorAll('ol.lines li').length === 2);
  assert.match(await b.textContent('#composer'), /줄이 올라갔어요/);
});

await step('writer C sees "someone is writing" and gets baton_held', async () => {
  await a.goto(storyUrl);                      // A will hold... no: A is at limit; use C vs B? B is at limit too.
  const d = await newUser('최지우', '2026100004');
  await d.goto(storyUrl);
  await d.click('text=이어 쓰기');
  await d.waitForSelector('#text');
  await c.goto(storyUrl);
  assert.match(await c.textContent('#status'), /누군가 쓰는 중/);
  await c.click('text=이어 쓰기');
  await c.waitForFunction(() => document.querySelector('#composerMsg')?.textContent.length > 0);
  assert.match(await c.textContent('#composerMsg'), /다른 사람이 이어 쓰는 중/);
  // D's baton expires; C takes over and posts; D posts late -> conflict screen
  await pool.query(`update app.stories set baton_expires_at = now() - interval '1 s' where baton_name = '최지우'`);
  await c.click('text=이어 쓰기');
  await c.waitForSelector('#text');
  await c.fill('#text', '우체통은 밤마다 편지를 뱉어냈다.');
  await c.click('#submitBtn');
  await c.waitForFunction(() => document.querySelectorAll('ol.lines li').length === 3);
  await d.fill('#text', '그 우체통에는 주인이 없었다.');
  await d.click('#submitBtn');
  await d.waitForSelector('text=관리자에게 전달되었어요');
  await d.screenshot({ path: `${SHOTS}/conflict.png`, fullPage: true });
  assert.equal(await d.locator('ol.lines li').count(), 3, 'conflict line not shown publicly');
  // "rewrite" claims again with the draft kept
  await d.click('text=새 줄에 이어서 다시 쓰기');
  await d.waitForSelector('#text');
  assert.equal(await d.inputValue('#text'), '그 우체통에는 주인이 없었다.');
  assert.match(await d.textContent('#composer'), /4번째 줄/);
  await d.click('text=취소');
});

await step('writer reveal: hidden by default, click shows name + student id', async () => {
  await b.goto(storyUrl);
  await b.waitForSelector('ol.lines li');
  assert.ok(!(await b.textContent('ol.lines')).includes('김철수'));
  await b.locator('ol.lines li').first().locator('button.who').click();
  assert.match(await b.textContent('ol.lines'), /김철수 \(2026100001\)/);
  await b.screenshot({ path: `${SHOTS}/story.png`, fullPage: true });
});

await step('final-line warning and completion', async () => {
  const id = new URL(storyUrl).searchParams.get('id');
  await pool.query(`update app.stories set max_lines = 4 where id = $1`, [id]);
  const e = await newUser('정하늘', '2026100005');
  await e.goto(storyUrl);
  await e.click('text=이어 쓰기');
  await e.waitForSelector('#text');
  assert.match(await e.textContent('#composer'), /마지막 줄/);
  await e.fill('#text', '그리고 마을은 다시 조용해졌다.');
  await e.click('#submitBtn');
  await e.waitForSelector('text=완결되었습니다');
  await e.goto(`${BASE}/`);
  await e.waitForSelector('#completed a');
  assert.match(await e.textContent('#completed'), /E2E 이야기/);
  await e.screenshot({ path: `${SHOTS}/index.png`, fullPage: true });
});

await step('admin: login, conflict queue, swap in keep following', async () => {
  const p = await newUser('admin', '0');
  await p.setViewportSize({ width: 1100, height: 900 });
  await p.goto(`${BASE}/admin.html`);
  await p.fill('input[name=email]', 'admin@test');
  await p.fill('input[name=password]', 'pw');
  await p.click('#login button');
  await p.waitForSelector('text=📙 conflict');
  assert.match(await p.textContent('#view'), /그 우체통에는 주인이 없었다/);
  await p.screenshot({ path: `${SHOTS}/admin-conflicts.png`, fullPage: true });
  await p.click('text=Swap in, keep following');
  await p.waitForSelector('text=No open conflicts.');
  await b.goto(storyUrl);
  await b.waitForSelector('ol.lines li');
  const texts = await b.locator('ol.lines .text').allTextContents();
  assert.match(texts[2], /그 우체통에는 주인이 없었다/);
  assert.equal(texts.length, 4);
});

await step('admin: story detail, rewind, settings save, stats, log, export', async () => {
  const p = await newUser('admin2', '0');
  await p.setViewportSize({ width: 1100, height: 900 });
  await p.goto(`${BASE}/admin.html`);
  await p.fill('input[name=email]', 'admin@test');
  await p.fill('input[name=password]', 'pw');
  await p.click('#login button');
  await p.click('nav button[data-tab=stories]');
  await p.click('text=E2E 이야기');
  await p.waitForSelector('text=Rewind to here');
  await p.screenshot({ path: `${SHOTS}/admin-story.png`, fullPage: true });
  await p.locator('tr', { hasText: '마을에는 이상한 우체통' }).locator('text=Rewind to here').click();
  await p.waitForSelector('text=Rewound.');
  assert.match(await p.textContent('#view'), /open · 2 \/ 4 lines/);
  await p.click('nav button[data-tab=settings]');
  await p.fill('input[name=max_chars]', '120');
  await p.click('#view button[type=submit]');
  await p.waitForSelector('text=Settings saved.');
  await p.click('nav button[data-tab=stats]');
  await p.waitForSelector('text=2026100001');
  await p.click('nav button[data-tab=log]');
  await p.waitForSelector('text=update_settings');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#export')]);
  const json = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.equal(json.settings.max_chars, 120);
});


await step('remote self-test page passes against local DB (as admin, cleans up)', async () => {
  const p = await newUser('tester', '0');
  await p.goto(`${BASE}/admin.html`);
  await p.fill('input[name=email]', 'admin@test');
  await p.fill('input[name=password]', 'pw');
  await p.click('#login button');
  await p.waitForSelector('#app:not([hidden])');
  await p.goto(`${BASE}/tests/remote/`);
  await p.click('#run');
  await p.waitForFunction(() => /ALL PASSED|FAILED|ERROR/.test(document.querySelector('#out').textContent), null, { timeout: 60000 }).catch(async e => { throw new Error(e.message + ' OUT=' + await p.textContent('#out')); });
  const out = await p.textContent('#out');
  assert.match(out, /ALL PASSED/, out);
  assert.match(out, /test story deleted/);
});

// Build a completed story directly in the DB (same functions, superuser).
async function makeCompleted(title, texts, sidBase) {
  const q = (sql, a) => pool.query(sql, a).then(r => r.rows[0].r);
  const { story_id } = await q(`select public.create_story($1, $2, $3, $4, 'seed') as r`, [title, texts[0], '작가A', `${sidBase}0`]);
  await pool.query(`update app.stories set max_lines = $2 where id = $1`, [story_id, texts.length]);
  for (let i = 1; i < texts.length; i++) {
    const head = (await pool.query(`select head_line_id from app.stories where id = $1`, [story_id])).rows[0].head_line_id;
    await q(`select public.submit_line($1, $2, $3, $4, $5, 'seed', null) as r`, [story_id, head, texts[i], `작가${'BCDEFG'[i - 1]}`, `${sidBase}${i}`]);
  }
  return story_id;
}

await step('export: single completed story (link, credits, txt download, PDF)', async () => {
  const first = await makeCompleted('먼저 끝난 이야기', ['첫 줄입니다.', '둘째 줄입니다.', '마지막 줄입니다.'], '20269900');
  await makeCompleted('나중에 끝난 이야기', ['하나.', '둘.'], '20269800');
  const p = await newUser('reader', '0');
  await p.goto(`${BASE}/story.html?id=${first}`);
  await p.click('text=이 이야기 내보내기');
  await p.waitForURL(/export\.html\?id=/);
  await p.waitForSelector('article.story');
  const text = await p.textContent('#book');
  assert.match(text, /먼저 끝난 이야기/);
  assert.match(text, /둘째 줄입니다\. — 작가B \(202699001\)/);
  assert.ok(!/차례/.test(text), 'no TOC for single story');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#txt')]);
  const txt = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(dl.suggestedFilename(), /^먼저_끝난_이야기-\d{8}\.txt$/);
  assert.match(txt, /^﻿?=+\n먼저 끝난 이야기\n/);
  assert.match(txt, /마지막 줄입니다\.  — 작가C \(202699002\)/);
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: `${SHOTS}/export-single.pdf`, format: 'A4' });
});

await step('export: all completed stories ordered by completion date, open ones excluded', async () => {
  const p = await newUser('reader2', '0');
  await p.goto(`${BASE}/`);
  await p.click('text=완결된 이야기 모두 내보내기');
  await p.waitForURL(/export\.html$/);
  await p.waitForSelector('nav.toc li');
  const toc = await p.locator('nav.toc li a').allTextContents();
  const exp = (await pool.query(`select coalesce(title, '제목 없는 이야기') t from app.stories
     where status = 'completed' and deleted_at is null order by completed_at, created_at`)).rows.map(r => r.t);
  assert.deepEqual(toc, exp);
  assert.ok(toc.indexOf('먼저 끝난 이야기') < toc.indexOf('나중에 끝난 이야기'));
  assert.ok(!toc.includes('E2E 이야기'), 'rewound (open) story excluded');
  assert.equal(await p.locator('article.story').count(), exp.length);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#txt')]);
  assert.match(dl.suggestedFilename(), /^relay-novel-\d{8}\.txt$/);
  await p.screenshot({ path: `${SHOTS}/export-all.png`, fullPage: true });
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: `${SHOTS}/export-all.pdf`, format: 'A4' });
});

await step('export: open story shows a clear message', async () => {
  const id = (await pool.query(`select id from app.stories where status = 'open' limit 1`)).rows[0].id;
  const p = await newUser('reader3', '0');
  await p.goto(`${BASE}/export.html?id=${id}`);
  await p.waitForSelector('#notice .box');
  assert.match(await p.textContent('#notice'), /완결된 이야기만/);
});

await step('admin credits toggle (select) changes export credits', async () => {
  const p = await newUser('admin3', '0');
  await p.goto(`${BASE}/admin.html`);
  await p.fill('input[name=email]', 'admin@test');
  await p.fill('input[name=password]', 'pw');
  await p.click('#login button');
  await p.click('nav button[data-tab=settings]');
  await p.selectOption('select[name=export_credits]', 'name');
  await p.click('#view button[type=submit]');
  await p.waitForSelector('text=Settings saved.');
  const r = await newUser('reader4', '0');
  await r.goto(`${BASE}/export.html`);
  await r.waitForSelector('article.story');
  const t = await r.textContent('#book');
  assert.match(t, /— 작가B/);
  assert.ok(!/\(20269900\d\)/.test(t), 'no student ids');
  await p.selectOption('select[name=export_credits]', 'none');
  await p.click('#view button[type=submit]');
  await p.waitForSelector('text=Settings saved.');
  await r.reload(); await r.waitForSelector('article.story');
  assert.ok(!(await r.textContent('#book')).includes('—'), 'no credits at all');
  await pool.query(`update app.settings set export_credits = 'name_sid'`);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
await browser.close(); server.close(); await pool.end();
