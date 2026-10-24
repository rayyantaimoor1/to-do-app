# Todo App — Build Plan

A personal task app with deadline reminders, installable on Windows and Android, syncing in real time, built to support multiple users from day one.

**Status:** Implemented (M1–M8). Deployment steps are in [SETUP.md](SETUP.md), which also lists where the implementation differs from this spec.
**Budget:** $0/month.

---

## 1. Requirements

| # | Requirement | How it's met |
|---|---|---|
| R1 | Installs on Windows laptop | Next.js PWA, installed from Chrome/Edge |
| R2 | Installs on Pixel 8 Pro as a real app | Signed APK via Capacitor, sideloaded |
| R3 | Login with Gmail | Supabase Auth → Google OAuth |
| R4 | Same account logged in on PC + phone simultaneously | Independent session per device |
| R5 | Stays logged in until explicit logout | Long-lived refresh tokens, auto-renewed |
| R6 | Each user's data fully isolated | Postgres Row Level Security |
| R7 | Tasks scoped to day / week / month with deadlines | `tasks.scope` + `tasks.due_at` |
| R8 | Escalating reminders as deadline approaches | Reminder ladder (§6.2) |
| R9 | Daily morning digest of everything outstanding | Digest job (§6.3) |
| R10 | Reminders fire when app is closed | Local alarms (Android) + server push (both) |
| R11 | Real-time sync between devices | Supabase Realtime over WebSocket |

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| UI | Next.js (`output: 'export'`) + React + TypeScript | Static export → wraps cleanly into an APK |
| Styling | Tailwind CSS | Fast, no runtime |
| Backend | Supabase (Postgres, Auth, Realtime, Edge Functions, pg_cron) | Everything needed in one free tier |
| Android | Capacitor + `@capacitor/local-notifications` | Same codebase → real APK with native alarms |
| Web hosting | Vercel (Hobby) | Free static hosting for the PWA |
| Local cache | Dexie (IndexedDB) | Offline-first on both platforms |
| Dates | Luxon | Timezone math for digests is non-trivial |

**Key architectural point:** the client talks to Supabase directly. There is no custom backend server. That's what allows a fully static build, which is what makes the Capacitor wrap trivial.

### Rejected alternatives

- **TWA / PWABuilder** — produces an APK, but it's a browser in a costume. No native alarm access, so it buys nothing over the plain PWA.
- **React Native / Flutter** — real native, but a separate codebase, and Windows would still need the web build. Two apps to maintain for one person.
- **Vercel Cron** — Hobby plan restricts frequency (roughly daily), which cannot serve "remind me 1 hour before." Scheduling lives in `pg_cron` instead. *This single choice is what keeps the project free.*
- **Firebase** — viable, but Firestore's security rules are weaker isolation than Postgres RLS, and there's no SQL for the digest queries.

---

## 3. Architecture

```
┌──────────────────┐         ┌──────────────────┐
│  Windows (PWA)   │         │  Pixel 8 (APK)   │
│  Next.js + SW    │         │  Next.js + Cap   │
│  IndexedDB cache │         │  IndexedDB cache │
│                  │         │  AlarmManager    │◄── local alarms
└────────┬─────────┘         └────────┬─────────┘
         │                            │
         │   WebSocket (Realtime)     │
         │   + REST (PostgREST)       │
         └────────────┬───────────────┘
                      ▼
         ┌────────────────────────────┐
         │        Supabase            │
         │  Postgres + RLS            │
         │  Auth (Google OAuth)       │
         │  Realtime                  │
         │  pg_cron ──► Edge Function │──► Web Push / FCM
         └────────────────────────────┘
```

**Two independent reminder paths, deliberately:**

1. **Local alarms (Android only)** — scheduled on-device the moment a task is created or edited. Fires with zero internet, exact to the second. This is the reliable path.
2. **Server push (both platforms)** — `pg_cron` sweeps every 5 minutes and pushes. This is the only path on Windows, and the backup path on Android.

They are deduplicated by notification `tag` (§6.5), so the phone never shows the same reminder twice.

---

## 4. Data model

```sql
-- ─────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────
create table profiles (
  id                uuid primary key references auth.users on delete cascade,
  email             text,
  display_name      text,
  timezone          text not null default 'UTC',   -- TODO: set IANA tz on first login
  digest_time       time not null default '08:00',
  quiet_hours_start time not null default '22:00',
  quiet_hours_end   time not null default '07:00',
  created_at        timestamptz not null default now()
);

-- auto-create a profile row when a user signs up
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─────────────────────────────────────────────────────────
-- tasks
-- ─────────────────────────────────────────────────────────
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  title        text not null check (length(trim(title)) > 0),
  notes        text,
  scope        text not null check (scope in ('day','week','month')),
  due_at       timestamptz not null,
  priority     smallint not null default 1 check (priority between 0 and 2),
  status       text not null default 'open' check (status in ('open','done')),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index tasks_due_idx on tasks (user_id, status, due_at);
create index tasks_sweep_idx on tasks (status, due_at) where status = 'open';

-- ─────────────────────────────────────────────────────────
-- push_subscriptions — one row per device
-- ─────────────────────────────────────────────────────────
create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  platform     text not null check (platform in ('web','android')),
  device_label text,                       -- "Windows laptop", "Pixel 8 Pro"
  endpoint     text not null unique,       -- web push endpoint, or FCM token
  p256dh       text,                       -- web push only
  auth_key     text,                       -- web push only
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index push_user_idx on push_subscriptions (user_id);

-- ─────────────────────────────────────────────────────────
-- notification_log — dedup + rate limiting
-- ─────────────────────────────────────────────────────────
create table notification_log (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users on delete cascade,
  task_id  uuid references tasks on delete cascade,
  kind     text not null,   -- 'lead' | 'due' | 'overdue' | 'digest'
  fire_key text not null,   -- see §6.5
  sent_at  timestamptz not null default now(),
  unique (user_id, fire_key)
);

create index notif_recent_idx on notification_log (user_id, sent_at desc);

-- ─────────────────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────────────────
create function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tasks_touch before update on tasks
  for each row execute function touch_updated_at();
```

### Row Level Security

Every table. This is R6, enforced at the database, not the UI.

```sql
alter table profiles            enable row level security;
alter table tasks               enable row level security;
alter table push_subscriptions  enable row level security;
alter table notification_log    enable row level security;

create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "own tasks" on tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own devices" on push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own notifications" on notification_log
  for select using (auth.uid() = user_id);
```

The cron sweep runs as `service_role`, which bypasses RLS by design — that's the only path that reads across users.

### Realtime

```sql
alter publication supabase_realtime add table tasks;
```

RLS applies to the realtime stream too: subscribers only receive change events for rows they can read. Friends never see each other's events.

---

## 5. Auth

**Flow:** Google OAuth via Supabase → session (access token + refresh token) stored per device.

- **Windows:** tokens in `localStorage`, refreshed automatically by `supabase-js`.
- **Android:** tokens in Capacitor Preferences (backed by Android SharedPreferences), so they survive app restarts. Requires a custom storage adapter passed to `createClient`.
- **R4 (simultaneous sessions):** each device gets its own refresh token. Independent by default — no work needed.
- **R5 (permanent login):** set refresh token expiry high in Supabase Auth settings. As long as the app is opened occasionally, the session renews forever.
- **Force logout:** `supabase.auth.signOut({ scope: 'global' })` revokes every device at once. Add a "Sign out everywhere" button in settings.

**On first login:** detect the device timezone with `Intl.DateTimeFormat().resolvedOptions().timeZone` and write it to `profiles.timezone`. The digest is wrong without this.

---

## 6. Notifications

The core of the app. Three questions: *when*, *what*, and *how do we avoid spam*.

### 6.1 Delivery matrix

| Event | Windows PWA | Android APK |
|---|---|---|
| Lead-up reminder | Server push | Local alarm (server push as backup) |
| Due-time reminder | Server push | Local alarm (server push as backup) |
| Overdue nag | Server push | Server push |
| Morning digest | Server push | Server push |

Overdue and digest are server-only because they depend on state the phone may not have (e.g. you completed the task on your laptop).

### 6.2 Reminder ladder

Offsets before `due_at`, chosen by scope so a month-away task doesn't ping you hourly:

| Scope | Lead reminders | At due |
|---|---|---|
| `day` | −1 h, −15 min | yes |
| `week` | −1 day, −3 h | yes |
| `month` | −3 days, −1 day | yes |

**Priority modifier:** `priority = 2` (high) adds a `−5 min` reminder and allows the overdue nag to repeat every 4 h. `priority = 0` (low) drops the earliest lead reminder.

**Overdue:** once `due_at` passes and `status = 'open'`, the task is folded into the morning digest daily until completed. It does **not** ping individually except for high-priority tasks (above). This is the anti-spam rule that makes R9 livable.

### 6.3 Morning digest (R9)

Runs from the same 5-minute sweep. For each user, compute local time from `profiles.timezone`; if it has crossed `digest_time` since the last sweep, send.

Contents, in order:
1. **Overdue** — every open task with `due_at < now`
2. **Due today**
3. **Due this week**

Single collapsed notification:

> **4 tasks need attention**
> 2 overdue · 1 due today · 1 this week

Tapping opens the app to a filtered view. If nothing is outstanding, send nothing — silence is the reward.

### 6.4 Quiet hours

No notification fires between `quiet_hours_start` and `quiet_hours_end` (default 22:00–07:00 local). Anything that would have fired is dropped, not queued — the morning digest catches it a few hours later anyway. Exception: `priority = 2` tasks due *during* quiet hours still fire.

### 6.5 Deduplication

Both paths can target the same reminder on Android. Two layers stop double-notifications:

1. **`fire_key`** — deterministic string, unique-constrained in `notification_log`:
   `{task_id}:{kind}:{scheduled_for_iso}` — e.g. `a1b2…:lead:2026-07-26T14:00:00Z`
   For digests: `{user_id}:digest:{local_date}`.
   The sweep inserts before sending; a unique violation means "already sent, skip." Safe against overlapping cron runs.

2. **Notification `tag`** — the client sets `tag = fire_key` on both the local alarm and the pushed notification. Android replaces same-tag notifications rather than stacking, so even if both paths fire, the user sees one.

### 6.6 The stale-alarm case

Known, accepted limitation. Task due 5 PM, alarm already scheduled on the phone. You complete it on the laptop at 3 PM.

- **Phone online** → receives the Realtime event, cancels the local alarm. Clean.
- **Phone offline/asleep** → may still fire at 5 PM for a completed task.

Mitigations, both to be built:
- The local notification handler re-checks task status in the local DB before displaying.
- On app resume / reconnect, reconcile: cancel alarms for any task now `done`, reschedule any that changed.

Residual risk: one stale ping, only while fully offline, self-correcting on reconnect. Not worth engineering further.

### 6.7 Android permissions

- `POST_NOTIFICATIONS` — runtime prompt, Android 13+. Ask on first task creation, not on launch.
- `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` — needed for to-the-minute firing on Android 14+.
- Prompt the user to exempt the app from battery optimisation. Optional but improves reliability.

---

## 7. Sync (R11)

**Offline-first.** Every read hits IndexedDB; the network updates the cache in the background. The UI never blocks on a request.

- **Write path:** optimistic — write local, render immediately, queue the remote write, reconcile on response.
- **Realtime:** subscribe to `postgres_changes` on `tasks` filtered by `user_id`. Typical propagation 100–300 ms.
- **Conflicts:** last-write-wins on `updated_at`. Correct choice for a personal app; CRDTs are over-engineering here.
- **Reconnect:** WebSockets die when the app is backgrounded. On resume — resubscribe, then fetch everything with `updated_at > last_sync_at` to fill the gap.
- **Outbox:** writes made offline queue in an IndexedDB table and flush on reconnect, in order.

---

## 8. Build order

Each milestone is independently verifiable. Don't move on until the current one works on **both** devices.

**M1 — Skeleton**
Next.js + TypeScript + Tailwind. Supabase project created, migrations from §4 applied. Google OAuth configured, login/logout working in the browser.

**M2 — Core CRUD**
Create/edit/complete/delete tasks. Views: Today, This Week, This Month, Overdue. RLS verified by trying to read another user's row and confirming it returns nothing.

**M3 — PWA + Windows install**
`manifest.json`, icons, service worker, offline shell. Confirm it installs from Edge/Chrome and launches in its own window. **R1 done.**

**M4 — Realtime + offline**
Dexie cache, optimistic writes, outbox, Realtime subscription. Test: airplane mode → add task → reconnect → appears on the other device. **R11 done.**

**M5 — Server push**
Generate VAPID keys. `push_subscriptions` registration on both platforms. Edge Function `reminder-sweep`. Schedule with `pg_cron` every 5 min. Reminder ladder + dedup. **R8 partially done.**

**M6 — Morning digest**
Timezone-aware digest logic, quiet hours, settings UI for `digest_time`. **R9 done.**

**M7 — Capacitor APK**
Add Capacitor, `@capacitor/local-notifications`. Custom auth storage adapter. Schedule/cancel alarms on task change. Generate signing key, build release APK, sideload to the Pixel. **R2, R10 done.**

**M8 — Polish**
Sign-out-everywhere, device list in settings, task search, keyboard shortcuts on desktop.

---

## 9. Repo layout

```
/src
  /app                    Next.js routes
  /components
  /lib
    supabase.ts           client + custom storage adapter
    db.ts                 Dexie schema, outbox
    sync.ts               realtime subscription, reconciliation
    notifications.ts      local alarm scheduling (Capacitor)
    reminders.ts          ladder logic — shared with the edge function
/supabase
  /migrations             SQL from §4
  /functions
    reminder-sweep/       Deno edge function
/android                  generated by Capacitor
/public
  manifest.json
  sw.js
capacitor.config.ts
next.config.js            output: 'export'
```

`reminders.ts` is deliberately shared between client and edge function so the ladder is defined exactly once. The local alarm and the server push must agree on timing or dedup by `fire_key` breaks.

---

## 10. Setup commands

```bash
# VAPID keys for web push (store in Supabase secrets, never commit)
npx web-push generate-vapid-keys

# Android signing key — back this up, it cannot be regenerated
keytool -genkey -v -keystore todo-release.keystore \
  -alias todo -keyalg RSA -keysize 2048 -validity 10000

# Capacitor
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/local-notifications
npx cap init
npx cap add android

# Build + install APK
npm run build && npx cap sync android
cd android && ./gradlew assembleRelease
```

**Environment variables**

| Var | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client | public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client | public — RLS is the protection |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | client | public |
| `VAPID_PRIVATE_KEY` | edge function secret | **never commit** |
| `SUPABASE_SERVICE_ROLE_KEY` | edge function secret | **never commit** — bypasses RLS |

Add `.env*`, `*.keystore`, and `/android/app/release` to `.gitignore` before the first commit.

---

## 11. Cost

| Service | Tier | Usage | Cost |
|---|---|---|---|
| Supabase | Free | ~1 MB DB, 2 realtime connections | $0 |
| Vercel | Hobby | Static site | $0 |
| Google OAuth | Free | — | $0 |
| Web Push (VAPID) | Free | — | $0 |
| APK sideload | — | No Play Store | $0 |

**Total: $0/month.**

Notes:
- Supabase pauses free projects after ~7 days of inactivity. The 5-minute cron plus daily use means this never triggers.
- Play Store listing, if ever wanted, is a **one-time $25**. Not needed to install on your own phone.
- Free-tier limits shift — worth confirming current numbers before starting.
- Growth path: Supabase Pro at $25/mo, no rewrite. Irrelevant below ~50 users.

---

## 12. Open decisions

Deferred, none blocking M1:

1. **Recurring tasks** ("every Monday") — deliberately out of scope. Adds a whole scheduling dimension. Revisit after M8.
2. **Subtasks / checklists** — not requested. Skip unless it comes up.
3. **Sharing with friends** — the schema supports separate users, but *shared* tasks between users would need a `task_shares` table and wider RLS policies. Not built; the isolation groundwork means it can be added without migration pain.
4. **Timezone while travelling** — currently a single stored timezone. Re-detecting on every launch could shift the digest unexpectedly. Leaving it manual.
5. **Digest for friends** — the sweep iterates all users; fine at small scale, would need batching past a few hundred.

---

## 13. Known limitations

Accepted trade-offs, recorded so they aren't rediscovered as bugs:

- **Stale offline alarm** (§6.6) — one possible reminder for an already-completed task, only while the phone is fully offline.
- **Windows reminders need internet** — no local alarm path in a PWA. If the laptop is offline at the reminder time, that reminder is missed. The phone covers this.
- **Sideloaded APK friction** — friends see an "unknown sources" warning and a Play Protect prompt. Fine for technical people; the $25 Play listing removes it.
- **APK updates are manual** — no auto-update outside the Play Store. The web portion updates on its own; only native shell changes need a fresh APK, which is rare.
