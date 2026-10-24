"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { supabase } from "@/lib/supabase";
import { db } from "@/lib/db";
import {
  currentEndpoint,
  unregisterThisDevice,
  type PushState,
} from "@/lib/push";
import {
  batteryOptimizationExempt,
  requestBatteryExemption,
} from "@/lib/notifications";
import {
  PROFILE_KEY,
  deviceTimeZone,
  updateProfile,
  type Profile,
  type ProfileSettings,
} from "@/lib/profile";
import { minuteInRange, parseTimeOfDay } from "@/lib/reminders";

interface SettingsProps {
  userId: string;
  pushState: PushState;
  onEnableReminders: () => Promise<void>;
  onSignOutEverywhere: () => Promise<void>;
  onShowShortcuts: () => void;
  onClose: () => void;
}

interface Device {
  id: string;
  platform: "web" | "android";
  device_label: string | null;
  endpoint: string;
  last_seen_at: string;
  created_at: string;
}

const PUSH_STATE_TEXT: Record<PushState, string> = {
  enabled: "Reminders are on for this device.",
  default: "Reminders are off for this device.",
  denied:
    "Notifications are blocked for this app. Allow them in your browser or phone settings, then reload.",
  unsupported:
    "This browser can't receive push reminders (or push isn't configured yet).",
  "needs-production-build":
    "Push only works in the installed/production build, not the dev server.",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ThisDevice({
  pushState,
  onEnableReminders,
}: {
  pushState: PushState;
  onEnableReminders: () => Promise<void>;
}) {
  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);

  useEffect(() => {
    void batteryOptimizationExempt().then(setBatteryExempt);
    // Re-check when returning from the system settings screen.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void batteryOptimizationExempt().then(setBatteryExempt);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-zinc-600 dark:text-zinc-300">
          {PUSH_STATE_TEXT[pushState]}
        </span>
        {pushState === "default" && (
          <button
            onClick={onEnableReminders}
            className="shrink-0 rounded-full bg-indigo-700 px-3 py-1.5 text-xs font-medium text-white"
          >
            Enable
          </button>
        )}
      </div>
      {batteryExempt === false && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-zinc-600 dark:text-zinc-300">
            Battery optimisation can delay reminders on this phone.
          </span>
          <button
            onClick={() => void requestBatteryExemption()}
            className="shrink-0 rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
          >
            Exempt app
          </button>
        </div>
      )}
    </div>
  );
}

function Devices({ userId }: { userId: string }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);

  const fetchDevices = useCallback(
    () =>
      supabase
        .from("push_subscriptions")
        .select("id,platform,device_label,endpoint,last_seen_at,created_at")
        .eq("user_id", userId)
        .order("created_at"),
    [userId],
  );

  const apply = ({ data, error }: Awaited<ReturnType<typeof fetchDevices>>) => {
    if (error) setError("Couldn't load devices — are you online?");
    else {
      setError(null);
      setDevices(data as Device[]);
    }
  };

  const load = async () => apply(await fetchDevices());

  useEffect(() => {
    void currentEndpoint().then(setThisEndpoint);
    void fetchDevices().then(({ data, error }) => {
      if (error) setError("Couldn't load devices — are you online?");
      else setDevices(data as Device[]);
    });
  }, [fetchDevices]);

  const remove = async (device: Device) => {
    const isThis = device.endpoint === thisEndpoint;
    if (
      !confirm(
        `Stop sending reminders to "${device.device_label ?? device.platform}"?` +
          (isThis ? " This is the device you're using." : ""),
      )
    ) {
      return;
    }
    if (isThis) {
      await unregisterThisDevice().catch(() => {});
    } else {
      const { error } = await supabase
        .from("push_subscriptions")
        .delete()
        .eq("id", device.id);
      if (error) {
        setError(`Couldn't remove device: ${error.message}`);
        return;
      }
    }
    await load();
  };

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!devices) return <p className="text-sm text-zinc-500">Loading...</p>;
  if (!devices.length) {
    return (
      <p className="text-sm text-zinc-500">
        No devices receive server reminders yet. Enable reminders on a device
        to add it here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
      {devices.map((d) => (
        <li key={d.id} className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="truncate font-medium text-zinc-900 dark:text-zinc-50">
              {d.device_label ?? d.platform}
              {d.endpoint === thisEndpoint && (
                <span className="ml-2 text-xs font-normal text-indigo-600">
                  this device
                </span>
              )}
            </p>
            <p className="text-xs text-zinc-500">
              {d.platform === "android" ? "Android app" : "Web"} · added{" "}
              {formatDate(d.created_at)} · last synced{" "}
              {formatDate(d.last_seen_at)}
            </p>
          </div>
          <button
            onClick={() => void remove(d)}
            className="shrink-0 text-xs font-medium text-red-500 hover:text-red-700"
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}

const hhmm = (t: string) => t.slice(0, 5);

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [deviceTimeZone()];
  }
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
        {title}
      </h3>
      {children}
    </section>
  );
}

const inputClass =
  "rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950";

function NotificationSettings({
  userId,
  profile,
}: {
  userId: string;
  profile: Profile;
}) {
  const [form, setForm] = useState<ProfileSettings>(() => ({
    timezone: profile.timezone,
    digest_time: hhmm(profile.digest_time),
    quiet_hours_start: hhmm(profile.quiet_hours_start),
    quiet_hours_end: hhmm(profile.quiet_hours_end),
  }));
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const zones = useMemo(() => timeZones(), []);
  const here = deviceTimeZone();

  const set = (key: keyof ProfileSettings) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const digestInQuiet = minuteInRange(
    parseTimeOfDay(form.digest_time),
    parseTimeOfDay(form.quiet_hours_start),
    parseTimeOfDay(form.quiet_hours_end),
  );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      await updateProfile(userId, form);
      setStatus("Saved");
    } catch (err) {
      setStatus(
        err instanceof Error
          ? `Couldn't save: ${err.message}`
          : "Couldn't save — are you online?",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        Timezone
        <div className="flex gap-2">
          <select
            value={form.timezone}
            onChange={(e) => set("timezone")(e.target.value)}
            className={`${inputClass} min-w-0 flex-1`}
          >
            {!zones.includes(form.timezone) && (
              <option value={form.timezone}>{form.timezone}</option>
            )}
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          {form.timezone !== here && (
            <button
              type="button"
              onClick={() => set("timezone")(here)}
              className="rounded-full border border-zinc-300 px-3 text-xs font-medium dark:border-zinc-700"
            >
              Use {here}
            </button>
          )}
        </div>
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Morning digest
          <input
            type="time"
            value={form.digest_time}
            onChange={(e) => set("digest_time")(e.target.value)}
            className={inputClass}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Quiet hours from
          <input
            type="time"
            value={form.quiet_hours_start}
            onChange={(e) => set("quiet_hours_start")(e.target.value)}
            className={inputClass}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          until
          <input
            type="time"
            value={form.quiet_hours_end}
            onChange={(e) => set("quiet_hours_end")(e.target.value)}
            className={inputClass}
            required
          />
        </label>
      </div>

      <p className="text-xs text-zinc-500">
        The digest lists overdue tasks, tasks due today, and tasks due this
        week. Nothing is sent when nothing is outstanding. During quiet hours
        reminders are skipped, except high-priority tasks that are due then.
      </p>
      {digestInQuiet && (
        <p className="text-xs font-medium text-amber-600">
          Your digest time is inside quiet hours, so the digest will never be
          sent. Move one of them.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {status && <span className="text-xs text-zinc-500">{status}</span>}
      </div>
    </form>
  );
}

export default function Settings({
  userId,
  pushState,
  onEnableReminders,
  onSignOutEverywhere,
  onShowShortcuts,
  onClose,
}: SettingsProps) {
  const profile = useLiveQuery(async () => {
    const row = await db.meta.get(PROFILE_KEY);
    return row ? (JSON.parse(row.value) as Profile) : null;
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Settings
        </h2>
        <button
          onClick={onClose}
          className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
        >
          Done
        </button>
      </div>

      <Section title="Reminders & digest">
        {profile === undefined ? (
          <p className="text-sm text-zinc-500">Loading...</p>
        ) : profile === null ? (
          <p className="text-sm text-zinc-500">
            Settings load once this device has been online.
          </p>
        ) : (
          // Remount when another device changes the profile so the form
          // shows the new values instead of stale local edits.
          <NotificationSettings
            key={JSON.stringify(profile)}
            userId={userId}
            profile={profile}
          />
        )}
      </Section>

      <Section title="This device">
        <ThisDevice
          pushState={pushState}
          onEnableReminders={onEnableReminders}
        />
      </Section>

      <Section title="Devices receiving reminders">
        <Devices userId={userId} />
      </Section>

      <Section title="Account">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-zinc-600 dark:text-zinc-300">
            Signs out this account on every device, including this one.
          </span>
          <button
            onClick={() => void onSignOutEverywhere()}
            className="shrink-0 rounded-full border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 dark:border-red-900"
          >
            Sign out everywhere
          </button>
        </div>
      </Section>

      <Section title="Keyboard shortcuts">
        <button
          onClick={onShowShortcuts}
          className="self-start rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
        >
          Show shortcuts ( ? )
        </button>
      </Section>
    </div>
  );
}
