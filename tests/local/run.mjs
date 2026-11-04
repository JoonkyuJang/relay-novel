// Local test suite for the relay-novel migration.
// Emulates PostgREST: every RPC runs in its own transaction as role anon
// (or authenticated with a JWT "sub"), exactly like Supabase does.
import pg from 'pg';
import assert from 'node:assert/strict';

const pool = new pg.Pool({ host: '/var/lib/postgresql/rn', port: 5433, user: 'postgres', database: 'rn', max: 60 });
const ADMIN = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

async function rpc(fn, args = {}, { as = 'anon', sub = null } = {}) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${as}`);
    if (sub) await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const res = await c.query(sql, keys.map(k => args[k]));
    await c.query('commit');
    return res.rows[0].r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}
const admin = (fn, args) => rpc(fn, args, { as: 'authenticated', sub: ADMIN });
async function expectErr(p, code) {
  try { await p; } catch (e) { assert.equal(e.message, code, `expected ${code}, got ${e.message}`); return e; }
  assert.fail(`expected error ${code}`);
}
const su = (q, a) => pool.query(q, a);
const who = i => ({ p_name: `작가${i}`, p_student_id: `2026${String(i).padStart(6, '0')}`, p_client: `client-${i}` });

// Official chain must be root -> head with positions 1..line_count, no gaps.
async function checkIntegrity(storyId) {
  const s = (await su('select * from app.stories where id=$1', [storyId])).rows[0];
  const lines = (await su(`select id,parent_id,depth from app.lines where story_id=$1 and kind='canonical' order by depth`, [storyId])).rows;
  assert.equal(lines.length, s.line_count, 'canonical count = line_count');
  lines.forEach((l, i) => {
    assert.equal(l.depth, i + 1, 'depths contiguous');
    assert.equal(l.parent_id, i === 0 ? null : lines[i - 1].id, 'chain linked');
  });
  if (lines.length) assert.equal(s.head_line_id, lines.at(-1).id, 'head = last canonical');
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1; }
}

console.log('relay-novel local tests');
await su(`insert into app.admins(user_id) values ($1)`, [ADMIN]);

await test('anon cannot touch private tables or helpers', async () => {
  const c = await pool.connect();
  try {
    for (const q of ['select * from app.stories', 'select app.is_admin()', 'insert into public.realtime_signals(key) values (\'x\')']) {
      await c.query('begin'); await c.query('set local role anon');
      await assert.rejects(c.query(q), /permission denied/); await c.query('rollback');
    }
  } finally { c.release(); }
});

await test('admin functions: anon denied, non-admin user rejected', async () => {
  await assert.rejects(rpc('admin_export'), /permission denied/);
  await expectErr(rpc('admin_export', {}, { as: 'authenticated', sub: USER }), 'not_admin');
  assert.equal(await rpc('is_admin', {}, { as: 'authenticated', sub: USER }), false);
  assert.equal(await admin('is_admin'), true);
});

let S1;
await test('create_story + validation', async () => {
  await expectErr(rpc('create_story', { p_title: null, p_text: '   ', ...who(1) }), 'empty_text');
  await expectErr(rpc('create_story', { p_title: null, p_text: '가'.repeat(101), ...who(1) }), 'too_long');
  await expectErr(rpc('create_story', { p_title: null, p_text: 'ok', ...who(1), p_student_id: '12 34$' }), 'invalid_student_id');
  await expectErr(rpc('create_story', { p_title: null, p_text: 'ok', ...who(1), p_name: '' }), 'invalid_name');
  const r = await rpc('create_story', { p_title: '  첫 이야기 ', p_text: '가'.repeat(100), ...who(1) });
  S1 = r.story_id;
  const s = await rpc('get_story', { p_story_id: S1 });
  assert.equal(s.title, '첫 이야기'); assert.equal(s.line_count, 1); assert.equal(s.lines[0].student_id, '2026000001');
});

await test('text cleanup: NFD Korean -> NFC, newlines collapsed', async () => {
  const nfd = '한글'.normalize('NFD');            // 6 code points
  const r = await rpc('create_story', { p_title: null, p_text: `${nfd}\n\n두 번째`, ...who(2) });
  const s = await rpc('get_story', { p_story_id: r.story_id });
  assert.equal(s.lines[0].text, '한글 두 번째');
  assert.equal(s.lines[0].text, s.lines[0].text.normalize('NFC'));
});

await test('stories_started_per_person cap (2), student id normalised', async () => {
  await rpc('create_story', { p_title: null, p_text: '세 번째?', ...who(3) });
  await rpc('create_story', { p_title: null, p_text: '네 번째?', ...who(3), p_student_id: '2026-000003' });
  await expectErr(rpc('create_story', { p_title: null, p_text: 'x', ...who(3), p_student_id: ' 2026 000003 ' }), 'story_limit');
});

await test('baton: claim, held by other, person_limit for starter, accept clears baton', async () => {
  await expectErr(rpc('claim_baton', { p_story_id: S1, ...who(1) }), 'person_limit');
  const b = await rpc('claim_baton', { p_story_id: S1, ...who(10) });
  assert.equal(b.position, 2); assert.equal(b.is_final, false);
  await expectErr(rpc('claim_baton', { p_story_id: S1, ...who(11) }), 'baton_held');
  const again = await rpc('claim_baton', { p_story_id: S1, ...who(10), p_client: 'other-device' });
  assert.ok(again.token);
  const list = await rpc('list_stories');
  assert.equal(list.find(x => x.id === S1).writing, true);
  const r = await rpc('submit_line', { p_story_id: S1, p_parent_id: b.parent_id, p_text: '둘째 줄', ...who(10), p_token: again.token });
  assert.equal(r.result, 'accepted'); assert.equal(r.position, 2);
  const s = await rpc('get_story', { p_story_id: S1 });
  assert.equal(s.writing, false); assert.equal(s.line_count, 2);
  await expectErr(rpc('claim_baton', { p_story_id: S1, ...who(10) }), 'person_limit');
  await checkIntegrity(S1);
});

await test('submitting while someone else holds the baton -> conflict (saved, hidden)', async () => {
  const s = await rpc('get_story', { p_story_id: S1 });
  await rpc('claim_baton', { p_story_id: S1, ...who(12) });
  const r = await rpc('submit_line', { p_story_id: S1, p_parent_id: s.head_line_id, p_text: '끼어들기', ...who(13), p_token: null });
  assert.equal(r.result, 'conflict'); assert.equal(r.reason, 'baton_taken');
  const after = await rpc('get_story', { p_story_id: S1 });
  assert.equal(after.line_count, 2); assert.equal(after.writing, true, 'holder keeps baton');
  await checkIntegrity(S1);
});

await test('expired baton does not block others', async () => {
  await su(`update app.stories set baton_expires_at = now() - interval '1 second' where id=$1`, [S1]);
  const b = await rpc('claim_baton', { p_story_id: S1, ...who(14) });
  assert.equal(b.position, 3);
  await rpc('release_baton', { p_story_id: S1, p_token: b.token });
  assert.equal((await rpc('get_story', { p_story_id: S1 })).writing, false);
});

let RACE;
await test('RACE: 40 writers submit to the same head at once -> exactly 1 accepted, 39 conflicts', async () => {
  RACE = (await rpc('create_story', { p_title: 'race', p_text: '시작', ...who(100) })).story_id;
  const head = (await rpc('get_story', { p_story_id: RACE })).head_line_id;
  const res = await Promise.allSettled(Array.from({ length: 40 }, (_, i) =>
    rpc('submit_line', { p_story_id: RACE, p_parent_id: head, p_text: `동시 ${i}`, ...who(200 + i), p_token: null })));
  const ok = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  const errs = res.filter(r => r.status === 'rejected').map(r => r.reason.message);
  assert.deepEqual(errs, [], 'no errors');
  assert.equal(ok.filter(r => r.result === 'accepted').length, 1);
  assert.equal(ok.filter(r => r.result === 'conflict').length, 39);
  await checkIntegrity(RACE);
  const confl = await admin('admin_list_conflicts');
  assert.equal(confl.filter(c => c.story_id === RACE).length, 39);
});

await test('RACE: 40 writers claim the baton at once -> exactly 1 wins', async () => {
  const res = await Promise.allSettled(Array.from({ length: 40 }, (_, i) =>
    rpc('claim_baton', { p_story_id: RACE, ...who(300 + i) })));
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(res.filter(r => r.status === 'rejected').every(r => r.reason.message === 'baton_held'));
  await rpc('admin_release_baton', { p_story_id: RACE }, { as: 'authenticated', sub: ADMIN });
});

await test('RACE: 5 rounds x 20 parallel appends each always from the latest head', async () => {
  for (let round = 0; round < 5; round++) {
    const head = (await rpc('get_story', { p_story_id: RACE })).head_line_id;
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      rpc('submit_line', { p_story_id: RACE, p_parent_id: head, p_text: `r${round}-${i}`, ...who(400 + round * 20 + i), p_token: null })));
    assert.equal(res.filter(r => r.result === 'accepted').length, 1, `round ${round}`);
  }
  await checkIntegrity(RACE);
  assert.equal((await rpc('get_story', { p_story_id: RACE })).line_count, 7);
});

await test('stale parent (writer 3 lines behind) -> conflict', async () => {
  const s = await rpc('get_story', { p_story_id: RACE });
  const r = await rpc('submit_line', { p_story_id: RACE, p_parent_id: s.lines[2].id, p_text: '늦음', ...who(600), p_token: null });
  assert.equal(r.result, 'conflict'); assert.equal(r.reason, 'stale_parent'); assert.equal(r.position, 4);
});

await test('fill to N=20: final-line flag, auto-complete, then closed', async () => {
  let s = await rpc('get_story', { p_story_id: RACE });
  let i = 700;
  while (s.line_count < 19) {
    const b = await rpc('claim_baton', { p_story_id: RACE, ...who(i) });
    await rpc('submit_line', { p_story_id: RACE, p_parent_id: b.parent_id, p_text: 'x', ...who(i), p_token: b.token });
    i++; s = await rpc('get_story', { p_story_id: RACE });
  }
  const b = await rpc('claim_baton', { p_story_id: RACE, ...who(i) });
  assert.equal(b.is_final, true); assert.equal(b.position, 20);
  const r = await rpc('submit_line', { p_story_id: RACE, p_parent_id: b.parent_id, p_text: '끝.', ...who(i), p_token: b.token });
  assert.equal(r.story_status, 'completed');
  await expectErr(rpc('claim_baton', { p_story_id: RACE, ...who(999) }), 'story_closed');
  await expectErr(rpc('submit_line', { p_story_id: RACE, p_parent_id: r.line_id, p_text: '더', ...who(999), p_token: null }), 'story_closed');
  await checkIntegrity(RACE);
});

await test('admin per-story override: max_lines=3, max_chars=10', async () => {
  const id = (await rpc('create_story', { p_title: null, p_text: '짧은 이야기', ...who(800) })).story_id;
  await admin('admin_update_story', { p_story_id: id, p: { max_lines: 3, max_chars: 10 } });
  const b = await rpc('claim_baton', { p_story_id: id, ...who(801) });
  assert.equal(b.max_chars, 10);
  await expectErr(rpc('submit_line', { p_story_id: id, p_parent_id: b.parent_id, p_text: '가'.repeat(11), ...who(801), p_token: b.token }), 'too_long');
  await rpc('submit_line', { p_story_id: id, p_parent_id: b.parent_id, p_text: '가'.repeat(10), ...who(801), p_token: b.token });
  const b2 = await rpc('claim_baton', { p_story_id: id, ...who(802) });
  assert.equal(b2.is_final, true);
  await rpc('submit_line', { p_story_id: id, p_parent_id: b2.parent_id, p_text: '끝', ...who(802), p_token: b2.token });
  assert.equal((await rpc('get_story', { p_story_id: id })).status, 'completed');
  await expectErr(admin('admin_update_story', { p_story_id: id, p: { status: 'open' } }), 'raise_max_lines_first');
  await admin('admin_update_story', { p_story_id: id, p: { max_lines: null, status: 'open' } });
  assert.equal((await rpc('get_story', { p_story_id: id })).max_lines, 20);
});

await test('swap in + keep following lines, then undo', async () => {
  // RACE line 2 has 39 conflicts; swap one in while lines 3..20 follow
  const before = await admin('admin_get_story', { p_story_id: RACE });
  const official2 = before.lines.find(l => l.kind === 'canonical' && l.position === 2);
  const official3 = before.lines.find(l => l.kind === 'canonical' && l.position === 3);
  const c = before.lines.find(l => l.kind === 'conflict' && l.position === 2);
  await admin('admin_replace_line', { p_line_id: c.id });
  let s = await admin('admin_get_story', { p_story_id: RACE });
  assert.equal(s.lines.find(l => l.id === c.id).kind, 'canonical');
  assert.equal(s.lines.find(l => l.id === c.id).conflict_status, 'promoted');
  assert.equal(s.lines.find(l => l.id === official2.id).kind, 'archived');
  assert.equal(s.lines.find(l => l.id === official3.id).parent_id, c.id);
  assert.equal(s.line_count, 20);
  await checkIntegrity(RACE);
  await admin('admin_replace_line', { p_line_id: official2.id });          // undo
  s = await admin('admin_get_story', { p_story_id: RACE });
  assert.equal(s.lines.find(l => l.id === official3.id).parent_id, official2.id);
  await checkIntegrity(RACE);
});

await test('swap in + cut after (set_head on a conflict) reopens story; undo restores', async () => {
  const before = await admin('admin_get_story', { p_story_id: RACE });
  const oldHead = before.head_line_id;
  const c = before.lines.find(l => l.kind === 'conflict' && l.position === 4);   // the stale one
  const r = await admin('admin_set_head', { p_line_id: c.id });
  assert.equal(r.line_count, 4); assert.equal(r.status, 'open'); assert.equal(r.archived, 17);
  await checkIntegrity(RACE);
  // archived lines no longer count toward the person cap: writer of old line 5 may write again
  const old5 = before.lines.find(l => l.kind === 'canonical' && l.position === 5);
  const b = await rpc('claim_baton', { p_story_id: RACE, p_name: old5.author_name, p_student_id: old5.student_id, p_client: 'x' });
  assert.equal(b.position, 5);
  await admin('admin_release_baton', { p_story_id: RACE });
  const u = await admin('admin_set_head', { p_line_id: oldHead });             // undo
  assert.equal(u.line_count, 20); assert.equal(u.status, 'completed');
  await checkIntegrity(RACE);
});

await test('rewind to line k, soft delete hides text, edit keeps original', async () => {
  const id = (await rpc('create_story', { p_title: null, p_text: '1', ...who(900) })).story_id;
  for (let i = 0; i < 4; i++) {
    const b = await rpc('claim_baton', { p_story_id: id, ...who(901 + i) });
    await rpc('submit_line', { p_story_id: id, p_parent_id: b.parent_id, p_text: String(i + 2), ...who(901 + i), p_token: b.token });
  }
  let s = await rpc('get_story', { p_story_id: id });
  await admin('admin_set_head', { p_line_id: s.lines[2].id });
  s = await rpc('get_story', { p_story_id: id });
  assert.equal(s.line_count, 3);
  await admin('admin_set_line_deleted', { p_line_id: s.lines[1].id, p_deleted: true });
  await admin('admin_edit_line', { p_line_id: s.lines[2].id, p_text: '고침' });
  s = await rpc('get_story', { p_story_id: id });
  assert.equal(s.lines[1].removed, true); assert.equal(s.lines[1].text, null); assert.equal(s.lines[1].author_name, null);
  assert.equal(s.lines[2].text, '고침'); assert.equal(s.lines[2].edited, true);
  const full = await admin('admin_get_story', { p_story_id: id });
  assert.equal(full.lines.find(l => l.id === s.lines[2].id).original_text, '3');
  await checkIntegrity(id);
});

await test('settings: hide student ids; lowering max_lines completes open stories', async () => {
  await admin('admin_update_settings', { p: { show_student_id: false } });
  const s = await rpc('get_story', { p_story_id: S1 });
  assert.ok(s.lines.every(l => l.student_id === null));
  await admin('admin_update_settings', { p: { max_lines: 2 } });
  assert.equal((await rpc('get_story', { p_story_id: S1 })).status, 'completed');
  await admin('admin_update_settings', { p: { max_lines: 20, show_student_id: true } });
  await expectErr(rpc('public_stats'), 'stats_hidden');
  await admin('admin_update_settings', { p: { stats_public: true } });
  assert.ok((await rpc('public_stats')).length > 0);
});

await test('submissions_open=false blocks writes; deleted story hidden', async () => {
  await admin('admin_update_settings', { p: { submissions_open: false } });
  await expectErr(rpc('create_story', { p_title: null, p_text: 'x', ...who(950) }), 'submissions_closed');
  await admin('admin_update_settings', { p: { submissions_open: true } });
  await admin('admin_set_story_deleted', { p_story_id: S1, p_deleted: true });
  assert.ok(!(await rpc('list_stories')).some(x => x.id === S1));
  await expectErr(rpc('get_story', { p_story_id: S1 }), 'story_not_found');
  await admin('admin_set_story_deleted', { p_story_id: S1, p_deleted: false });
});

await test('admin stats, log, export, realtime signals', async () => {
  const st = await admin('admin_stats');
  assert.ok(st.find(x => x.student_id === '2026000003').started === 2);
  assert.ok((await admin('admin_log_recent', { p_limit: 5 })).length === 5);
  const ex = await admin('admin_export');
  assert.ok(ex.lines.length > 100 && !('baton_token' in ex.stories[0]));
  const sig = (await su(`select key, version from public.realtime_signals`)).rows;
  assert.ok(sig.some(x => x.key === 'list' && Number(x.version) > 50));
});

await test('export: completed only, ordered by completion, hidden lines omitted', async () => {
  const open = (await rpc('create_story', { p_title: '진행 중', p_text: '아직', ...who(1000) })).story_id;
  await expectErr(rpc('export_stories', { p_story_id: open }), 'story_not_completed');
  await expectErr(rpc('export_stories', { p_story_id: '00000000-0000-0000-0000-000000000000' }), 'story_not_found');

  const all = await rpc('export_stories');
  assert.ok(all.stories.length >= 2);
  assert.ok(all.stories.every(s => s.lines.length > 0));
  const times = all.stories.map(s => s.completed_at);
  assert.deepEqual(times, [...times].sort(), 'ordered by completed_at');
  assert.ok(!all.stories.some(s => s.id === open), 'open stories excluded');
  assert.equal(all.credits, 'name_sid');
  assert.ok(all.stories[0].lines[0].author_name && all.stories[0].lines[0].student_id);

  // a hidden line is omitted from export
  const full = await admin('admin_get_story', { p_story_id: RACE });
  const victim = full.lines.find(l => l.kind === 'canonical' && l.position === 5);
  await admin('admin_set_line_deleted', { p_line_id: victim.id, p_deleted: true });
  const one = await rpc('export_stories', { p_story_id: RACE });
  assert.equal(one.stories.length, 1);
  assert.ok(!one.stories[0].lines.some(l => l.position === 5));
  assert.equal(one.stories[0].lines.length, 19);
  await admin('admin_set_line_deleted', { p_line_id: victim.id, p_deleted: false });

  // deleted stories excluded
  await admin('admin_set_story_deleted', { p_story_id: RACE, p_deleted: true });
  assert.ok(!(await rpc('export_stories')).stories.some(s => s.id === RACE));
  await expectErr(rpc('export_stories', { p_story_id: RACE }), 'story_not_found');
  await admin('admin_set_story_deleted', { p_story_id: RACE, p_deleted: false });
});

await test('export credits toggle: name_sid / name / none (server-side)', async () => {
  await admin('admin_update_settings', { p: { export_credits: 'name' } });
  let e = await rpc('export_stories', { p_story_id: RACE });
  assert.ok(e.stories[0].lines.every(l => l.author_name && l.student_id === null));
  await admin('admin_update_settings', { p: { export_credits: 'none' } });
  e = await rpc('export_stories', { p_story_id: RACE });
  assert.ok(e.stories[0].lines.every(l => l.author_name === null && l.student_id === null));
  await assert.rejects(admin('admin_update_settings', { p: { export_credits: 'bogus' } }), /check constraint/);
  await admin('admin_update_settings', { p: { export_credits: 'name_sid' } });
  assert.equal((await admin('admin_get_settings')).export_credits, 'name_sid');
});

await test('guestbook: post, validation, newest first, paging, hidden student id', async () => {
  await expectErr(rpc('post_guestbook', { p_text: '  ', ...who(2000) }), 'empty_text');
  await expectErr(rpc('post_guestbook', { p_text: '가'.repeat(201), ...who(2000) }), 'too_long');
  for (let i = 0; i < 5; i++) await rpc('post_guestbook', { p_text: `방명록 ${i}\n줄바꿈`, ...who(2001 + i) });
  const page = await rpc('list_guestbook', { p_limit: 3 });
  assert.equal(page.total, 5); assert.equal(page.items.length, 3); assert.equal(page.has_more, true);
  assert.equal(page.items[0].text, '방명록 4 줄바꿈');
  assert.ok(page.items[0].no > page.items[1].no);
  const next = await rpc('list_guestbook', { p_before: page.items[2].no, p_limit: 3 });
  assert.equal(next.items.length, 2); assert.equal(next.has_more, false);
  assert.equal(page.items[0].student_id, '2026002005');
  await admin('admin_update_settings', { p: { show_student_id: false } });
  assert.equal((await rpc('list_guestbook', {})).items[0].student_id, null);
  await admin('admin_update_settings', { p: { show_student_id: true } });
});

await test('guestbook: 30 s cooldown per student id and per device (race-safe)', async () => {
  const e = await expectErr(rpc('post_guestbook', { p_text: '또', ...who(2001) }), 'cooldown');
  assert.ok(JSON.parse(e.detail).wait > 0);
  await expectErr(rpc('post_guestbook', { p_text: '다른 학번, 같은 기기', ...who(2999), p_client: 'client-2001' }), 'cooldown');
  const res = await Promise.allSettled(Array.from({ length: 10 }, () =>
    rpc('post_guestbook', { p_text: '연타', ...who(3000) })));
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 1);
  await su(`update app.guestbook set created_at = created_at - interval '31 seconds'`);
  await rpc('post_guestbook', { p_text: '이제 됨', ...who(2001) });
});

await test('guestbook: admin hide/restore, closed setting, length setting, export', async () => {
  const all = await admin('admin_list_guestbook', {});
  assert.ok(all[0].student_id && all[0].client_token);
  await admin('admin_set_guestbook_deleted', { p_id: all[0].id, p_deleted: true });
  assert.ok(!(await rpc('list_guestbook', {})).items.some(i => i.id === all[0].id));
  await admin('admin_set_guestbook_deleted', { p_id: all[0].id, p_deleted: false });
  await admin('admin_update_settings', { p: { guestbook_open: false } });
  await expectErr(rpc('post_guestbook', { p_text: 'x', ...who(4000) }), 'guestbook_closed');
  await admin('admin_update_settings', { p: { guestbook_open: true, guestbook_max_chars: 5 } });
  await expectErr(rpc('post_guestbook', { p_text: '여섯 글자요', ...who(4000) }), 'too_long');
  await admin('admin_update_settings', { p: { guestbook_max_chars: 200 } });
  const s = await rpc('get_public_settings');
  assert.equal(s.guestbook_max_chars, 200); assert.equal(s.guestbook_cooldown_seconds, 30);
  assert.ok((await admin('admin_export')).guestbook.length >= 7);
  await assert.rejects(rpc('admin_list_guestbook', {}), /permission denied/);
});

await test('no consecutive lines by the same person (when 2+ lines allowed), switchable', async () => {
  await admin('admin_update_settings', { p: { lines_per_person_per_story: 2, max_lines: 20 } });
  const id = (await rpc('create_story', { p_title: null, p_text: '하나', ...who(5000) })).story_id;
  await expectErr(rpc('claim_baton', { p_story_id: id, ...who(5000) }), 'consecutive');
  const head = (await rpc('get_story', { p_story_id: id })).head_line_id;
  await expectErr(rpc('submit_line', { p_story_id: id, p_parent_id: head, p_text: '몰래', ...who(5000), p_token: null }), 'consecutive');
  const b = await rpc('claim_baton', { p_story_id: id, ...who(5001) });
  await rpc('submit_line', { p_story_id: id, p_parent_id: b.parent_id, p_text: '둘', ...who(5001), p_token: b.token });
  const c = await rpc('claim_baton', { p_story_id: id, ...who(5000) });          // allowed again after someone else
  await rpc('submit_line', { p_story_id: id, p_parent_id: c.parent_id, p_text: '셋', ...who(5000), p_token: c.token });
  await expectErr(rpc('claim_baton', { p_story_id: id, ...who(5000) }), 'person_limit');
  await admin('admin_update_settings', { p: { allow_consecutive_lines: true } });
  const d = await rpc('claim_baton', { p_story_id: id, ...who(5001) });
  await rpc('submit_line', { p_story_id: id, p_parent_id: d.parent_id, p_text: '넷', ...who(5001), p_token: d.token });
  assert.equal((await rpc('get_public_settings')).allow_consecutive_lines, true);
  await admin('admin_update_settings', { p: { allow_consecutive_lines: false, lines_per_person_per_story: 1 } });
});

await test('extras: defaults, admin merge, unknown keys and wrong types rejected', async () => {
  const s = await rpc('get_public_settings');
  assert.equal(s.extras.cat_name, '문냥이'); assert.equal(s.extras.stamps, true);
  assert.equal(s.extras.deadline, '2026-11-23T00:00:00+09:00');
  const r = await admin('admin_update_settings', { p: { extras: { cat_name: '백냥이', saver_typing_min: 4 } } });
  assert.equal(r.extras.cat_name, '백냥이'); assert.equal(r.extras.saver_typing_min, 4); assert.equal(r.extras.cat, true);
  await expectErr(admin('admin_update_settings', { p: { extras: { nope: true } } }), 'invalid_settings');
  await expectErr(admin('admin_update_settings', { p: { extras: { cat: 'yes' } } }), 'invalid_settings');
  await expectErr(admin('admin_update_settings', { p: { extras: [1] } }), 'invalid_settings');
  await assert.rejects(rpc('admin_update_settings', { p: { extras: { cat: false } } }), /permission denied/);
  await admin('admin_update_settings', { p: { extras: { cat_name: '문냥이', saver_typing_min: 3 } } });
});

await test('stamps: one of each kind per person, toggle off, counts, mine, positions, admin view', async () => {
  const id = (await rpc('create_story', { p_title: '도장', p_text: '첫 줄', ...who(6000) })).story_id;
  const line = (await rpc('get_story', { p_story_id: id })).lines[0].id;
  const a = await rpc('toggle_stamp', { p_line_id: line, p_kind: 'sun', ...who(6001) });
  assert.deepEqual([a.stamped, a.counts.sun], [true, 1]);
  await rpc('toggle_stamp', { p_line_id: line, p_kind: 'laugh', ...who(6001) });
  await rpc('toggle_stamp', { p_line_id: line, p_kind: 'sun', ...who(6002), p_student_id: '2026-006002' });
  const res = await Promise.allSettled(Array.from({ length: 8 }, () =>
    rpc('toggle_stamp', { p_line_id: line, p_kind: 'cur', ...who(6003) })));
  assert.ok(res.every(r => r.status === 'fulfilled'));          // even toggles → back to off
  let all = await rpc('get_story_stamps', { p_story_id: id, p_student_id: '2026 006001' });
  assert.deepEqual(all[line].counts, { sun: 2, laugh: 1, cur: 0 });
  assert.deepEqual(all[line].mine.sort(), ['laugh', 'sun']);
  for (const [k, x, y, r] of all[line].marks) { assert.ok(['sun', 'laugh'].includes(k)); assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1 && Math.abs(r) <= 25); }
  const off = await rpc('toggle_stamp', { p_line_id: line, p_kind: 'sun', ...who(6001) });
  assert.deepEqual([off.stamped, off.counts.sun], [false, 1]);
  assert.equal((await rpc('get_story_stamps', { p_story_id: id })) [line].mine.length, 0);
  await expectErr(rpc('toggle_stamp', { p_line_id: line, p_kind: 'heart', ...who(6001) }), 'invalid_kind');
  assert.equal((await admin('admin_line_stamps', { p_line_id: line })).length, 2);
  await assert.rejects(rpc('admin_line_stamps', { p_line_id: line }), /permission denied/);
  await admin('admin_set_line_deleted', { p_line_id: line, p_deleted: true });
  await expectErr(rpc('toggle_stamp', { p_line_id: line, p_kind: 'sun', ...who(6009) }), 'line_not_found');
  assert.deepEqual(await rpc('get_story_stamps', { p_story_id: id }), {});
  await admin('admin_set_line_deleted', { p_line_id: line, p_deleted: false });
  await admin('admin_update_settings', { p: { extras: { stamps: false } } });
  await expectErr(rpc('toggle_stamp', { p_line_id: line, p_kind: 'sun', ...who(6009) }), 'feature_off');
  await admin('admin_update_settings', { p: { extras: { stamps: true } } });
});

await test('counters: cat pets; 휴지통 counts batons let go without a line', async () => {
  const before = (await rpc('get_about')).cat_pets;
  await Promise.all(Array.from({ length: 5 }, () => rpc('pet_cat')));
  assert.equal(Number(await rpc('pet_cat')), before + 6);
  const trash = async () => (await rpc('get_about')).trash;
  const t0 = await trash();
  const id = (await rpc('create_story', { p_title: null, p_text: '하나', ...who(7000) })).story_id;
  let b = await rpc('claim_baton', { p_story_id: id, ...who(7001) });
  await rpc('release_baton', { p_story_id: id, p_token: b.token });                 // let go → +1
  assert.equal(await trash(), t0 + 1);
  b = await rpc('claim_baton', { p_story_id: id, ...who(7001) });
  await rpc('claim_baton', { p_story_id: id, ...who(7001) });                       // re-claim own live baton → +0
  assert.equal(await trash(), t0 + 1);
  await su(`update app.stories set baton_expires_at = now() - interval '1 second' where id = $1`, [id]);
  assert.equal(await trash(), t0 + 1);                                               // expiry itself is silent
  b = await rpc('claim_baton', { p_story_id: id, ...who(7002) });                   // taking over an expired one → +1
  assert.equal(await trash(), t0 + 2);
  await rpc('submit_line', { p_story_id: id, p_parent_id: b.parent_id, p_text: '둘', ...who(7002), p_token: b.token });
  assert.equal(await trash(), t0 + 2);                                               // a written line → +0
  await admin('admin_update_settings', { p: { extras: { cat: false } } });
  await expectErr(rpc('pet_cat'), 'feature_off');
  await admin('admin_update_settings', { p: { extras: { cat: true } } });
});

await test('story cards and about', async () => {
  await admin('admin_update_settings', { p: { max_lines: 2 } });
  const id = (await rpc('create_story', { p_title: '카드', p_text: '가나다', ...who(8000) })).story_id;
  const b = await rpc('claim_baton', { p_story_id: id, ...who(8001) });
  const r = await rpc('submit_line', { p_story_id: id, p_parent_id: b.parent_id, p_text: '라마바사', ...who(8001), p_token: b.token });
  assert.equal(r.story_status, 'completed');
  const line = (await rpc('get_story', { p_story_id: id })).lines[1].id;
  await rpc('toggle_stamp', { p_line_id: line, p_kind: 'cur', ...who(8002) });
  const card = (await rpc('story_cards'))[id];
  assert.deepEqual(card, { chars: 7, writers: 2, stamps: { sun: 0, laugh: 0, cur: 1 } });
  const about = await rpc('get_about');
  assert.ok(about.stories >= 1 && about.lines >= 2 && about.stamps >= 1 && about.since);
  await admin('admin_update_settings', { p: { max_lines: 20 } });
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
await pool.end();
