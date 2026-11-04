# Relay Novel (릴레이 소설)

A relay-novel site: people write a short story together, one line each.
Static frontend on GitHub Pages + a Supabase (Postgres) backend.

**Stage 1 (now):** technical foundation with a deliberately plain UI.
**Stage 2:** visual design, replay, likes, anthology export, branching.

## How it works

- All data lives in the private `app` schema. The browser can only call the
  functions in `public` (see `supabase/migrations/`), which enforce every rule.
- Lines form a **tree** (`parent_id`). The official story is the chain of
  `canonical` lines from the first line to `stories.head_line_id`. A unique index
  guarantees at most one official line per position.
- **Baton:** clicking "이어 쓰기" reserves the next line for a few minutes
  (`claim_baton`). Others see "누군가 쓰는 중".
- **Safeguard:** `submit_line` sends the line it continues from. If that is still
  the latest line, it is accepted. If not (or someone else holds the baton),
  the line is still saved, as a hidden **conflict** flagged for the admin.
  Each story's writes are serialized with a row lock.
- **Admin tools** never delete: "Rewind to here" / "Swap in + cut after" move
  later lines to `archived`; "Swap in, keep following" replaces one line and
  re-attaches the rest. Each can be undone the same way. Soft delete just hides.
- Live updates: clients subscribe to `public.realtime_signals` and re-fetch,
  with a 20 s poll as a fallback.

## Files

```
index.html                          연문회 OS (single page: boot → login → windows; routes #/stories, #/story/<id>,
                                    #/new, #/roster, #/guestbook, #/help)
admin.html                          redirect to #/admin (the console is a 연문회 OS window, js/views/admin.js)
story.html, export.html             redirects for old links
css/base.css                        the whole visual system (tokens, windows, mobile layout, CRT)
fonts/                              Neo둥근모 + 갈무리11 (subset), OFL — see fonts/README.md
js/api.js                           the ONLY file that talks to the backend (+ local identity/prefs)
js/wm.js                            window manager: draggable windows on desktop, one window at a time on phones
js/index.js                         app shell: boot, login, menu bar, icons/dock, routing, presence
js/views/*.js                       one file per window
js/config.js                        project URL + publishable key (safe to publish)
js/vendor/                          supabase-js 2.117.3 (MIT), vendored
supabase/migrations/                database schema + functions (applied by the GitHub integration)
tests/local/                        local Postgres test suite + browser e2e (for development)
tests/remote/                       concurrency test against the live project (browser or Node)
```

Login is honor-system: name + student number are stored only in the visitor's browser and
sent with each write. "둘러보기" lets people read without logging in.

## Setup (one time)

1. **Supabase → Project Settings → Integrations → GitHub**: connect this repo,
   working directory `.`, production branch `main`, *Deploy to production* on,
   automatic branching off. Pushing to `main` applies new files in `supabase/migrations/`.
2. After the first deploy, make your account an admin. In **SQL Editor** run:
   ```sql
   insert into app.admins (user_id)
   select id from auth.users where email = 'YOUR_ADMIN_EMAIL';
   ```
3. **GitHub → Settings → Pages**: deploy from branch `main`, folder `/ (root)`.
   The site is then at `https://joonkyujang.github.io/relay-novel/`.
4. Open `…/relay-novel/tests/remote/` (logged in as admin first) and run
   the concurrency self-test.

## Admin

There is no visible admin button. On the 연문회 OS login window, type the admin **email in 이름**
(the 학번 field turns into a password field) and the **password in 학번**, then 들어가기.
A wrong password shows the same message as any other login problem. The 관리 menu and the
관리자 콘솔 window appear; 관리자 나가기 inside the console signs out.

## Changing the database

Never edit an applied migration. Add a new file
`supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` and push.

## Local tests (development machine with PostgreSQL 16)

```
cd tests/local && npm install
npm test        # resets a local DB, applies migrations, runs run.mjs (25 checks incl. races)
npm run e2e     # browser flows with Playwright against the same local DB (16 flows, desktop + phone)
```
`reset.sh` expects a local server on socket `/var/lib/postgresql/rn`, port 5433.
