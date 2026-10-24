import {
  LocalNotifications,
  type LocalNotificationSchema,
} from "@capacitor/local-notifications";
import { PushNotifications } from "@capacitor/push-notifications";
import { registerPlugin } from "@capacitor/core";
import { supabase } from "@/lib/supabase";
import { db } from "@/lib/db";
import { cachedProfile } from "@/lib/profile";
import {
  safeTimeZone,
  scheduledReminders,
  suppressedByQuietHours,
  type QuietHours,
} from "@/lib/reminders";
import {
  FCM_ENABLED,
  REMINDER_CHANNEL_ID,
  isNative,
} from "@/lib/platform";

/** android/app/src/main/java/.../BatteryOptimizationPlugin.java */
const BatteryOptimization = registerPlugin<{
  isIgnoring(): Promise<{ ignoring: boolean }>;
  request(): Promise<void>;
}>("BatteryOptimization");

/** null on web, where there's nothing to exempt. */
export async function batteryOptimizationExempt(): Promise<boolean | null> {
  if (!isNative()) return null;
  try {
    return (await BatteryOptimization.isIgnoring()).ignoring;
  } catch {
    return null;
  }
}

export async function requestBatteryExemption(): Promise<void> {
  await BatteryOptimization.request();
}

/** Android caps pending alarms per app (~500); keep well clear of it. */
const MAX_SCHEDULED = 300;

/**
 * Local notification ids are 32-bit ints, so derive one from the fire_key
 * (FNV-1a). Same reminder → same id, which is what lets a diff against
 * `getPending()` work across app restarts.
 */
export function notificationId(fireKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < fireKey.length; i++) {
    h ^= fireKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 1) || 1;
}

export async function createReminderChannel(): Promise<void> {
  if (!isNative()) return;
  const channel = {
    id: REMINDER_CHANNEL_ID,
    name: "Reminders",
    description: "Task deadline reminders and the morning digest",
    importance: 5 as const,
    visibility: 1 as const,
  };
  await LocalNotifications.createChannel(channel);
  if (FCM_ENABLED) await PushNotifications.createChannel(channel);
}

export type NativePermission = "granted" | "denied" | "prompt";

export async function nativePermission(): Promise<NativePermission> {
  const { display } = await LocalNotifications.checkPermissions();
  return display === "granted"
    ? "granted"
    : display === "denied"
      ? "denied"
      : "prompt";
}

/** POST_NOTIFICATIONS runtime prompt (Android 13+), §6.7. */
export async function requestNativePermission(): Promise<NativePermission> {
  const { display } = await LocalNotifications.requestPermissions();
  return display === "granted" ? "granted" : "denied";
}

// ─────────────────────────────────────────────────────────
// Alarm reconciliation (§6.6)
// ─────────────────────────────────────────────────────────

async function desiredNotifications(
  now: number,
): Promise<LocalNotificationSchema[]> {
  const tasks = await db.tasks.where("status").equals("open").toArray();
  const profile = await cachedProfile();
  const quiet: QuietHours | null = profile && {
    timeZone: safeTimeZone(profile.timezone),
    start: profile.quiet_hours_start,
    end: profile.quiet_hours_end,
  };

  const out: { at: number; notification: LocalNotificationSchema }[] = [];
  for (const task of tasks) {
    for (const r of scheduledReminders(task)) {
      if (r.at <= now) continue;
      if (quiet && suppressedByQuietHours(r, task, quiet)) continue;
      out.push({
        at: r.at,
        notification: {
          id: notificationId(r.fireKey),
          title: task.title,
          body: r.body,
          channelId: REMINDER_CHANNEL_ID,
          autoCancel: true,
          schedule: { at: new Date(r.at), allowWhileIdle: true },
          extra: { fireKey: r.fireKey, url: `/?view=${task.scope}` },
        },
      });
    }
  }
  return out
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_SCHEDULED)
    .map((x) => x.notification);
}

/**
 * Newest server `updated_at` among tasks this device has fully applied.
 * Rows with queued local edits still carry this device's clock, so they're
 * left out until the flush replaces them with the server row.
 */
async function syncedThrough(): Promise<string | null> {
  const pending = new Set(
    (await db.outbox.toArray()).map((e) => e.taskId),
  );
  let max: string | null = null;
  await db.tasks.each((t) => {
    if (pending.has(t.id)) return;
    if (!max || new Date(t.updated_at) > new Date(max)) max = t.updated_at;
  });
  return max;
}

async function reportSynced(endpoint: string | null) {
  if (!endpoint || !navigator.onLine) return;
  const through = await syncedThrough();
  if (!through) return;
  const { error } = await supabase.rpc("touch_device", {
    p_endpoint: endpoint,
    p_synced_through: through,
  });
  if (error) console.warn("touch_device failed:", error.message);
}

let chain: Promise<void> = Promise.resolve();

/**
 * Make the OS's pending alarms match the local task cache: cancel alarms for
 * tasks completed/deleted/moved, schedule new ones, reschedule changed text.
 * Serialized so overlapping triggers can't interleave cancel/schedule.
 */
export function syncAlarms(fcmEndpoint: string | null): Promise<void> {
  if (!isNative()) return Promise.resolve();
  chain = chain.then(async () => {
    try {
      if ((await nativePermission()) !== "granted") return;

      const desired = await desiredNotifications(Date.now());
      const wanted = new Map(desired.map((n) => [n.id, n]));
      const { notifications: pending } = await LocalNotifications.getPending();

      const cancel = pending.filter((p) => {
        const want = wanted.get(p.id);
        if (!want) return true;
        // Same fire_key but the title changed: replace it.
        if (want.title !== p.title || want.body !== p.body) return true;
        wanted.delete(p.id);
        return false;
      });

      if (cancel.length) {
        await LocalNotifications.cancel({
          notifications: cancel.map((p) => ({ id: p.id })),
        });
      }
      if (wanted.size) {
        await LocalNotifications.schedule({ notifications: [...wanted.values()] });
      }

      await reportSynced(fcmEndpoint);
    } catch (err) {
      console.error("Alarm sync failed:", err);
    }
  });
  return chain;
}

export async function cancelAllAlarms(): Promise<void> {
  if (!isNative()) return;
  const { notifications } = await LocalNotifications.getPending();
  if (notifications.length) {
    await LocalNotifications.cancel({
      notifications: notifications.map((n) => ({ id: n.id })),
    });
  }
}

// ─────────────────────────────────────────────────────────
// FCM registration (server push to Android, optional)
// ─────────────────────────────────────────────────────────

/** Resolves with this install's FCM token. */
export async function fcmToken(): Promise<string> {
  const { receive } = await PushNotifications.requestPermissions();
  if (receive !== "granted") throw new Error("Notification permission denied");

  return new Promise<string>((resolve, reject) => {
    const handles = Promise.all([
      PushNotifications.addListener("registration", (t) => {
        void handles.then((hs) => hs.forEach((h) => h.remove()));
        resolve(t.value);
      }),
      PushNotifications.addListener("registrationError", (e) => {
        void handles.then((hs) => hs.forEach((h) => h.remove()));
        reject(new Error(e.error));
      }),
    ]);
    void handles.then(() => PushNotifications.register());
  });
}
