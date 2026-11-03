// Concurrency check against the REAL Supabase project, from a terminal (Node 18+):
//
//   node tests/remote/concurrency.mjs
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/remote/concurrency.mjs   # also cleans up
//
// Same test runs in the browser at tests/remote/ (index.html).
import { SUPABASE_URL, SUPABASE_KEY } from '../../js/config.js';
import { runConcurrencyTest } from './concurrency-lib.mjs';

let accessToken = null;
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
  accessToken = (await res.json()).access_token ?? null;
}
const ok = await runConcurrencyTest({
  writers: Number(process.env.WRITERS ?? 25), rounds: Number(process.env.ROUNDS ?? 3), accessToken });
process.exitCode = ok ? 0 : 1;
