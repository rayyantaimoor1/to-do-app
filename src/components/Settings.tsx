"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
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
  onClose: () => void;
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

export default function Settings({ userId, onClose }: SettingsProps) {
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
    </div>
  );
}
