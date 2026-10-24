// reminder-sweep — PLAN.md §6. Invoked every 5 minutes by pg_cron
// (supabase/cron.sql). Runs with the service role, so it reads across users;
// it is the only code path that does.
//
// Secrets (set with `supabase secrets set`, never committed):
//   CRON_SECRET          shared secret pg_cron sends as a Bearer token
//   VAPID_PUBLIC_KEY     web push
//   VAPID_PRIVATE_KEY    web push
//   VAPID_SUBJECT        mailto: or https: contact for push services
//   FCM_SERVICE_ACCOUNT  optional — Firebase service-account JSON for Android
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.

import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import webpush from "npm:web-push@3.6.7";
import {
  type QuietHours,
  type Reminder,
  type ReminderTask,
  digestCounts,
  digestFireKey,
  digestMessage,
  digestWindowDate,
  inQuietHours,
  latestOverdueNag,
  safeTimeZone,
  scheduledReminders,
  suppressedByQuietHours,
} from "../_shared/reminders.ts";

/**
 * How far back a reminder may be and still fire. Wider than the 5-minute
 * cron interval so a late or skipped run doesn't lose reminders; the
 * fire_key unique constraint stops overlapping windows from double-sending.
 */
const LOOKBACK_MS = 15 * 60 * 1000;
/** Furthest-ahead task the sweep cares about: the 7-day digest horizon + slack. */
const HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

interface TaskRow extends ReminderTask {
  user_id: string;
  title: string;
  updated_at: string;
}

interface Profile {
  id: string;
  timezone: string;
  digest_time: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
}

interface Subscription {
  id: string;
  user_id: string;
  platform: "web" | "android";
  endpoint: string;
  p256dh: string | null;
  auth_key: string | null;
  last_seen_at: string;
}

interface Message {
  title: string;
  body: string;
  tag: string;
  url: string;
}

const env = (name: string) => Deno.env.get(name) ?? "";

const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const webPushReady =
  !!env("VAPID_PUBLIC_KEY") && !!env("VAPID_PRIVATE_KEY") && !!env("VAPID_SUBJECT");
if (webPushReady) {
  webpush.setVapidDetails(
    env("VAPID_SUBJECT"),
    env("VAPID_PUBLIC_KEY"),
    env("VAPID_PRIVATE_KEY"),
  );
}

// ─────────────────────────────────────────────────────────
// Dedup (§6.5): claim the fire_key before sending
// ─────────────────────────────────────────────────────────

async function claim(
  userId: string,
  taskId: string | null,
  kind: string,
  key: string,
): Promise<boolean> {
  const { error } = await admin.from("notification_log").insert({
    user_id: userId,
    task_id: taskId,
    kind,
    fire_key: key,
  });
  if (!error) return true;
  // Unique violation: another run (or an earlier one) already sent it.
  if (error.code === "23505") return false;
  throw error;
}

// ─────────────────────────────────────────────────────────
// Delivery
// ─────────────────────────────────────────────────────────

async function removeSubscription(id: string) {
  await admin.from("push_subscriptions").delete().eq("id", id);
}

async function sendWeb(sub: Subscription, msg: Message) {
  if (!webPushReady || !sub.p256dh || !sub.auth_key) return;
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
      JSON.stringify(msg),
      { TTL: 60 * 60, urgency: "high" },
    );
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // 404/410: the browser revoked or expired the subscription.
    if (status === 404 || status === 410) await removeSubscription(sub.id);
    else throw err;
  }
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const serviceAccount: ServiceAccount | null = (() => {
  const raw = env("FCM_SERVICE_ACCOUNT");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ServiceAccount;
  } catch {
    console.error("FCM_SERVICE_ACCOUNT is not valid JSON; Android push disabled");
    return null;
  }
})();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

let fcmToken: { value: string; expires: number } | null = null;

async function fcmAccessToken(sa: ServiceAccount): Promise<string> {
  if (fcmToken && fcmToken.expires > Date.now() + 60_000) return fcmToken.value;

  const iat = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  })}`;

  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`FCM auth failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  fcmToken = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return fcmToken.value;
}

async function sendAndroid(sub: Subscription, msg: Message) {
  if (!serviceAccount) return;
  const token = await fcmAccessToken(serviceAccount);
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: sub.endpoint,
          notification: { title: msg.title, body: msg.body },
          data: { url: msg.url, tag: msg.tag },
          android: {
            priority: "high",
            notification: { tag: msg.tag, channel_id: "reminders" },
          },
        },
      }),
    },
  );
  if (res.ok) return;
  const text = await res.text();
  if (res.status === 404 || text.includes("UNREGISTERED")) {
    await removeSubscription(sub.id);
    return;
  }
  throw new Error(`FCM send failed: ${res.status} ${text}`);
}

/**
 * Android devices schedule lead/due reminders as local alarms (M7). Server
 * push for those is only a backup, for when the phone hasn't synced since the
 * task last changed — `last_seen_at` is bumped (server clock) every time the
 * phone reschedules its alarms. Overdue nags and digests always go out.
 */
function wantsDelivery(sub: Subscription, reminder: Reminder | null, task?: TaskRow) {
  if (sub.platform === "web") return true;
  if (!reminder || reminder.kind === "overdue" || !task) return true;
  return new Date(sub.last_seen_at).getTime() < new Date(task.updated_at).getTime();
}

async function deliver(
  subs: Subscription[],
  msg: Message,
  reminder: Reminder | null,
  task?: TaskRow,
): Promise<number> {
  let delivered = 0;
  for (const sub of subs) {
    if (!wantsDelivery(sub, reminder, task)) continue;
    try {
      if (sub.platform === "web") await sendWeb(sub, msg);
      else await sendAndroid(sub, msg);
      delivered++;
    } catch (err) {
      console.error(`Delivery to ${sub.platform} ${sub.id} failed:`, err);
    }
  }
  return delivered;
}

// ─────────────────────────────────────────────────────────
// Sweep
// ─────────────────────────────────────────────────────────

const VIEW_FOR_SCOPE: Record<string, string> = { day: "day", week: "week", month: "month" };

async function sweep(now: number) {
  const { data: subRows, error: subErr } = await admin
    .from("push_subscriptions")
    .select("id,user_id,platform,endpoint,p256dh,auth_key,last_seen_at");
  if (subErr) throw subErr;
  const subs = (subRows ?? []) as Subscription[];

  const subsByUser = new Map<string, Subscription[]>();
  for (const s of subs) {
    const list = subsByUser.get(s.user_id) ?? [];
    list.push(s);
    subsByUser.set(s.user_id, list);
  }
  const userIds = [...subsByUser.keys()];
  if (userIds.length === 0) return { users: 0, reminders: 0, digests: 0 };

  const [{ data: profileRows, error: profErr }, { data: taskRows, error: taskErr }] =
    await Promise.all([
      admin
        .from("profiles")
        .select("id,timezone,digest_time,quiet_hours_start,quiet_hours_end")
        .in("id", userIds),
      admin
        .from("tasks")
        .select("id,user_id,title,scope,due_at,priority,status,created_at,updated_at")
        .eq("status", "open")
        .in("user_id", userIds)
        .lte("due_at", new Date(now + HORIZON_MS).toISOString()),
    ]);
  if (profErr) throw profErr;
  if (taskErr) throw taskErr;

  const tasksByUser = new Map<string, TaskRow[]>();
  for (const t of (taskRows ?? []) as TaskRow[]) {
    const list = tasksByUser.get(t.user_id) ?? [];
    list.push(t);
    tasksByUser.set(t.user_id, list);
  }

  let reminders = 0;
  let digests = 0;

  for (const profile of (profileRows ?? []) as Profile[]) {
    const userSubs = subsByUser.get(profile.id) ?? [];
    const tasks = tasksByUser.get(profile.id) ?? [];
    const quiet: QuietHours = {
      timeZone: safeTimeZone(profile.timezone),
      start: profile.quiet_hours_start,
      end: profile.quiet_hours_end,
    };

    for (const task of tasks) {
      const due = scheduledReminders(task);
      const nag = latestOverdueNag(task, now);
      if (nag) due.push(nag);

      for (const r of due) {
        if (r.at > now || r.at <= now - LOOKBACK_MS) continue;
        if (suppressedByQuietHours(r, task, quiet)) continue;
        if (!(await claim(profile.id, task.id, r.kind, r.fireKey))) continue;
        const view = r.kind === "overdue" ? "overdue" : VIEW_FOR_SCOPE[task.scope];
        await deliver(
          userSubs,
          { title: task.title, body: r.body, tag: r.fireKey, url: `/?view=${view}` },
          r,
          task,
        );
        reminders++;
      }
    }

    // Morning digest (§6.3) — same sweep, no separate cron job.
    const windowDate = digestWindowDate(now, quiet.timeZone, profile.digest_time);
    if (windowDate && !inQuietHours(now, quiet)) {
      const msg = digestMessage(digestCounts(tasks, now, quiet.timeZone));
      // Nothing outstanding → send nothing. No log row either, so a task
      // added later inside the window can still trigger today's digest.
      if (msg) {
        const key = digestFireKey(profile.id, windowDate);
        if (await claim(profile.id, null, "digest", key)) {
          await deliver(userSubs, { ...msg, tag: key, url: `/?view=${msg.view}` }, null);
          digests++;
        }
      }
    }
  }

  return { users: userIds.length, reminders, digests };
}

Deno.serve(async (req) => {
  const secret = env("CRON_SECRET");
  if (!secret || req.headers.get("Authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const result = await sweep(Date.now());
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("Sweep failed:", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
