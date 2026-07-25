# Claude Code Build Prompts

Ready-to-paste prompts for building this app in Claude Code, one per milestone from [PLAN.md](PLAN.md) §8. Each prompt is self-contained (it points Claude Code at the relevant PLAN.md sections rather than restating them) and ends with a commit + push.

## How to use this

1. Run milestones **in order** — each one assumes the previous is done and pushed.
2. Before pasting a prompt, switch to the recommended model:
   ```
   /model <model-id>
   ```
3. Paste the prompt for that milestone as your message.
4. Verify the test plan in the prompt actually passes (in the browser / on the phone) before moving to the next milestone. Don't take "done" on faith — the prompts tell Claude Code to walk you through verification, not just claim success.
5. Each prompt ends with committing and pushing to `origin/main`. If a milestone touches secrets (VAPID private key, service role key, keystore passwords), the prompt tells Claude Code to have you run that step yourself rather than handling it directly.

## Model summary

| Milestone | Model | Model ID | Why |
|---|---|---|---|
| M1 — Skeleton | Sonnet 5 | `claude-sonnet-5` | Project scaffolding and config — well-trodden patterns, low ambiguity |
| M2 — Core CRUD | Sonnet 5 | `claude-sonnet-5` | Standard CRUD UI/data-layer work |
| M3 — PWA + Windows install | Sonnet 5 | `claude-sonnet-5` | Manifest/service-worker config, low risk |
| M4 — Realtime + offline | Opus 5 | `claude-opus-5` | Optimistic writes, outbox ordering, conflict resolution — correctness-sensitive |
| M5 — Server push | Opus 5 | `claude-opus-5` | Handles the service role key and dedup/timing logic that's easy to get subtly wrong |
| M6 — Morning digest | Sonnet 5 | `claude-sonnet-5` | Extends M5's infra; contained logic, but test timezone/DST edges carefully |
| M7 — Capacitor APK | Opus 5 | `claude-opus-5` | Native alarms, permissions, signing — highest cost if the reminder timing gets subtly wrong |
| M8 — Polish | Sonnet 5 | `claude-sonnet-5` | Additive UI work, no architectural risk left |

---

## M1 — Skeleton

**Model:** Sonnet 5 (`/model claude-sonnet-5`)

```
Read PLAN.md in this repo fully before starting, especially §2 Stack, §4 Data
model, §9 Repo layout, §10 Setup commands. We're building Milestone M1:
Skeleton.

Prerequisites I've already done manually — confirm you don't need to redo
them: I've created a Supabase project and enabled Google as an OAuth
provider in Supabase Auth settings. I'll paste the project URL and anon key
into .env.local when you ask for them.

Do the following:
1. Scaffold a Next.js + TypeScript project using output: 'export' per
   PLAN.md §2, following the /src layout in §9.
2. Install and configure Tailwind CSS.
3. Add supabase-js and create src/lib/supabase.ts with the client per §5
   (leave a TODO for the custom storage adapter — that's M7).
4. Create the SQL migrations in /supabase/migrations from PLAN.md §4 exactly
   (profiles, tasks, push_subscriptions, notification_log, RLS policies,
   realtime publication).
5. Create .env.local.example with the variable names from §10. Do not put
   real secrets in it, and confirm .env* is in .gitignore.
6. Ask me for my Supabase URL and anon key, apply the migrations using the
   Supabase CLI, and wire up Google OAuth login/logout on a bare-bones page.
7. Verify: I should be able to run the dev server, click "Sign in with
   Google", and see my session persist across a page refresh.

Do not build task CRUD yet — that's M2. Keep this milestone strictly to
project setup and auth.

When everything above works and I've confirmed it in the browser, commit
your changes with a clear message and push to origin/main.
```

---

## M2 — Core CRUD

**Model:** Sonnet 5 (`/model claude-sonnet-5`)

```
Read PLAN.md §4 (tasks table). We're building Milestone M2: Core CRUD. Do
not add offline caching or Dexie yet — that's M4; talk to Supabase directly
for now.

1. Build a task list UI with four views: Today, This Week, This Month,
   Overdue — filtered on tasks.scope and tasks.due_at.
2. Build a task creation form: title, notes, scope (day/week/month), due_at
   (date+time picker), priority (0-2).
3. Implement edit, mark-complete/incomplete, and delete.
4. Style with Tailwind — clean and usable, not fancy.
5. Verify RLS is actually enforced, not just assumed: create a second
   throwaway Supabase user (or query as a different auth.uid() via the SQL
   editor) and confirm my main account cannot see or query that user's
   tasks. Show me the exact query and result you used to verify this.

When CRUD works end-to-end in the browser and you've shown me the RLS
verification, commit and push to origin/main.
```

---

## M3 — PWA + Windows install

**Model:** Sonnet 5 (`/model claude-sonnet-5`)

```
We're building Milestone M3: PWA + Windows install, per PLAN.md §8 M3.

1. Add manifest.json with app name, icons, theme colors, and
   display: standalone. Ask me if I have a logo/icon file before generating
   placeholder icons.
2. Add a service worker that caches the static app shell for offline
   loading — do not cache/intercept API calls yet, that's M4's job.
3. Wire the manifest and service worker correctly into the static export.
4. Verify installability: run the production build, serve it, and walk me
   through installing it from Edge or Chrome on Windows as a standalone
   window.

Ask me to confirm the install worked and the app opens in its own window
(not a browser tab) before finishing.

When confirmed, commit and push to origin/main.
```

---

## M4 — Realtime + offline

**Model:** Opus 5 (`/model claude-opus-5`)

```
Read PLAN.md §7 (Sync) in full — this is the trickiest data-correctness
work so far, worth extra care. We're building Milestone M4: Realtime +
offline.

1. Add Dexie and mirror the tasks table schema locally (§4) in IndexedDB.
2. Make every read in the UI hit the local Dexie cache first; sync it from
   Supabase in the background.
3. Make writes optimistic: write to Dexie immediately, render instantly,
   queue the write in an outbox table, then flush to Supabase.
4. Flush the outbox in order, so out-of-order writes can't corrupt state.
5. Subscribe to Supabase Realtime on the tasks table filtered to my
   user_id; apply incoming changes to Dexie.
6. Implement last-write-wins conflict resolution based on updated_at, per
   §7.
7. Implement reconnect reconciliation: on regaining connection, resubscribe
   and fetch everything with updated_at > last_sync_at to fill any gap.

Test plan — walk me through verifying each one, don't just claim it works:
- Turn on airplane mode, add and edit a task, confirm the UI updates
  instantly with no errors.
- Reconnect, confirm the change appears on Supabase and on a second
  browser tab within a few hundred ms.
- Edit the same task on two tabs while one is offline, reconnect, confirm
  last-write-wins resolves without crashing or duplicating.

When all three test cases pass and you've shown me the results, commit and
push to origin/main.
```

---

## M5 — Server push

**Model:** Opus 5 (`/model claude-opus-5`)

```
Read PLAN.md §6 in full, plus §10. We're building Milestone M5: Server
push.

Prerequisite I need to do manually first: generate VAPID keys (command is
in §10) and store them as Supabase Edge Function secrets. Give me the exact
supabase CLI commands and I'll run them myself — the private key must never
be pasted into chat or committed.

1. Add web push subscription registration on the client: request
   notification permission, subscribe via the Push API, upsert the
   subscription into push_subscriptions with a device_label.
2. Create src/lib/reminders.ts with the reminder ladder logic from §6.2,
   written so it can be imported by both the client (later, in M7) and the
   edge function — do not duplicate the ladder definition anywhere.
3. Build the supabase/functions/reminder-sweep Edge Function: find open
   tasks whose next reminder offset has arrived, respect quiet hours
   (§6.4), compute fire_key and insert into notification_log first (§6.5)
   to dedupe via the unique constraint, then send via web-push to every
   subscription for that user.
4. Schedule the sweep with pg_cron every 5 minutes — give me the exact SQL
   to run in the Supabase SQL editor.
5. Verify: create a task due 2 minutes from now with scope 'day', confirm a
   real push notification arrives on my Windows machine while the tab is
   closed.

Do not build the morning digest yet (M6) and don't touch anything
Android/Capacitor (M7).

When the test notification arrives, and you've confirmed dedup works
(trigger the sweep twice manually, confirm only one notification is sent),
commit and push to origin/main.
```

---

## M6 — Morning digest

**Model:** Sonnet 5 (`/model claude-sonnet-5`)

```
Read PLAN.md §6.3 and §6.4. We're building Milestone M6: Morning digest,
extending the M5 reminder-sweep function — do not create a separate cron
job.

1. Add Luxon and use profiles.timezone to compute each user's local time
   inside the sweep.
2. Track whether today's digest has already been sent, using
   notification_log with fire_key = {user_id}:digest:{local_date} per
   §6.5, so re-running the sweep doesn't double-send.
3. When local time has just crossed profiles.digest_time, build the
   digest: count overdue / due today / due this week, and send one
   collapsed notification (format per §6.3). Send nothing if nothing is
   outstanding.
4. Add a settings UI section for digest_time and
   quiet_hours_start/quiet_hours_end, writing to profiles.
5. Verify: temporarily set digest_time to a couple minutes from now,
   trigger the sweep, confirm exactly one digest notification arrives, and
   confirm running the sweep again immediately does not send a second one.
   Also check behavior isn't broken across a DST boundary if one falls
   within the next few weeks.

When verified, commit and push to origin/main.
```

---

## M7 — Capacitor APK

**Model:** Opus 5 (`/model claude-opus-5`)

```
Read PLAN.md §6.6, §6.7, §10, and §12 note 1 (recurring tasks are
explicitly out of scope — don't add them). We're building Milestone M7:
Capacitor APK.

Prerequisite I need to do manually: install Android Studio and generate the
release keystore using the keytool command in §10. Walk me through it
interactively rather than running it yourself, since I need to set and keep
the passwords myself.

1. Add Capacitor and @capacitor/local-notifications per §10, run
   cap init and cap add android.
2. Build a custom Supabase auth storage adapter backed by Capacitor
   Preferences, per §5, so sessions survive app restarts on Android.
3. On task create/edit/delete, schedule/reschedule/cancel local
   notifications using the SAME reminders.ts ladder from M5 — import it,
   do not reimplement it.
4. Set the notification tag to the fire_key format from §6.5 so local and
   server notifications dedupe against each other.
5. Implement the reconciliation logic from §6.6: on app resume and on
   realtime reconnect, cancel alarms for tasks now marked done, and
   reschedule any whose due_at changed.
6. Request POST_NOTIFICATIONS at first task creation (not on launch), and
   handle SCHEDULE_EXACT_ALARM/USE_EXACT_ALARM per §6.7.
7. Build the release APK using the keystore I generated, and walk me
   through sideloading it onto my Pixel 8 Pro.

Test plan — walk me through each, don't just claim success:
- Create a task due 2 minutes out, turn on airplane mode, confirm the
  local notification still fires exactly on time.
- Complete a task on the Windows PWA while the phone is online, confirm
  the phone's alarm is cancelled.
- Complete a task on the Windows PWA while the phone is in airplane mode
  with an alarm already due, confirm it still fires once (expected per
  §6.6), then confirm reconnecting afterward doesn't produce a duplicate.

When all three pass, commit and push to origin/main.
```

---

## M8 — Polish

**Model:** Sonnet 5 (`/model claude-sonnet-5`)

```
Read PLAN.md §8 M8 and §5 (force logout). We're building Milestone M8:
Polish — the last planned milestone.

1. Add a "Sign out everywhere" button in settings using
   supabase.auth.signOut({ scope: 'global' }) per §5.
2. Add a device list in settings, reading from push_subscriptions
   (device_label, platform, last_seen_at), with the ability to remove a
   stale device's subscription.
3. Add task search/filter by title.
4. Add keyboard shortcuts on the desktop PWA for common actions (new task,
   mark complete, navigate views) — pick sensible bindings and tell me
   what they are.
5. Pass over the whole app for rough edges: loading states, empty states,
   error toasts for failed syncs.

After this is done, walk me through every requirement in PLAN.md §1
(R1–R11) one by one and confirm each still works end-to-end.

When the walkthrough is done, commit and push to origin/main.
```
