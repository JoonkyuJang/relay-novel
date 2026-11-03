// Shared concurrency check against the REAL Supabase project.
// Used by concurrency.mjs (Node) and index.html (browser).
import { SUPABASE_URL, SUPABASE_KEY } from '../../js/config.js';

export async function runConcurrencyTest({ writers = 25, rounds = 3, log = console.log, accessToken = null } = {}) {
  const WRITERS = writers;
  const ROUNDS = rounds;
  const run = Math.random().toString(36).slice(2, 7).toUpperCase();

  async function rpc(fn, args) {
    const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${fn}: ${res.status} ${body?.message ?? ''} ${body?.details ?? ''}`);
    return body;
  }
  const who = (i) => ({ p_name: `테스트${i}`, p_student_id: `T${run}${String(i).padStart(4, '0')}`, p_client: `test-${run}-${i}` });

  let failed = false;
  const check = (ok, msg) => { log(ok ? '  ✓' : '  ✗', msg); if (!ok) failed = true; };

  log(`remote concurrency test (run ${run}, ${WRITERS} writers x ${ROUNDS} rounds)`);
  const settings = await rpc('get_public_settings', {});
  check(settings.max_lines >= ROUNDS + 1, `site max_lines (${settings.max_lines}) leaves room for ${ROUNDS} rounds`);

  const { story_id } = await rpc('create_story', { p_title: `[TEST] concurrency ${run}`, p_text: '동시성 테스트 시작', ...who(0) });
  log('  story', story_id);

  for (let r = 0; r < ROUNDS; r++) {
    const head = (await rpc('get_story', { p_story_id: story_id })).head_line_id;
    const t0 = Date.now();
    const results = await Promise.allSettled(Array.from({ length: WRITERS }, (_, i) =>
      rpc('submit_line', { p_story_id: story_id, p_parent_id: head, p_text: `라운드 ${r} 작가 ${i}`,
        ...who(1 + r * WRITERS + i), p_token: null })));
    const ok = results.filter(x => x.status === 'fulfilled').map(x => x.value);
    const errors = results.filter(x => x.status === 'rejected').map(x => x.reason.message);
    const accepted = ok.filter(x => x.result === 'accepted').length;
    const conflicts = ok.filter(x => x.result === 'conflict').length;
    check(accepted === 1 && conflicts === WRITERS - 1 && errors.length === 0,
      `round ${r + 1}: ${accepted} accepted, ${conflicts} conflicts, ${errors.length} errors (${Date.now() - t0} ms)`);
    if (errors.length) log('    ', [...new Set(errors)].join('\n     '));
  }

  // baton race
  const claims = await Promise.allSettled(Array.from({ length: WRITERS }, (_, i) =>
    rpc('claim_baton', { p_story_id: story_id, ...who(9000 + i) })));
  const won = claims.filter(x => x.status === 'fulfilled');
  check(won.length === 1 && claims.filter(x => x.status === 'rejected').every(x => /baton_held/.test(x.reason.message)),
    `baton race: ${won.length} of ${WRITERS} claims succeeded`);
  if (won[0]) await rpc('release_baton', { p_story_id: story_id, p_token: won[0].value.token });

  const s = await rpc('get_story', { p_story_id: story_id });
  const positions = s.lines.map(l => l.position);
  check(s.line_count === ROUNDS + 1 && positions.every((p, i) => p === i + 1),
    `final story: ${s.line_count} lines, positions ${positions.join(',')}`);

  if (accessToken) {
    const conflicts = (await rpc('admin_list_conflicts', {})).filter(c => c.story_id === story_id).length;
    check(conflicts === (WRITERS - 1) * ROUNDS, `admin sees ${conflicts} flagged conflicts`);
    await rpc('admin_set_story_deleted', { p_story_id: story_id, p_deleted: true });
    log('  test story deleted (soft)');
  } else {
    log('  (not logged in as admin: delete the "[TEST]" story in admin.html)');
  }

  log(failed ? '\nFAILED' : '\nALL PASSED');
  return !failed;
}
