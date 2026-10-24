/**
 * Reminder ladder, quiet hours and digest windows — PLAN.md §6.
 *
 * This file is the single definition of reminder timing. It is imported by
 * the `reminder-sweep` edge function (Deno) and re-exported to the app via
 * `src/lib/reminders.ts` (local alarms on Android). The two paths must
 * compute byte-identical `fire_key`s or dedup (§6.5) breaks, so keep this
 * file dependency-free and runtime-agnostic: no imports, only standard
 * `Date` and `Intl`, which both Deno and browsers ship.
 */

export type ReminderScope = "day" | "week" | "month";
export type ReminderKind = "lead" | "due" | "overdue";

export interface ReminderTask {
  id: string;
  scope: ReminderScope;
  due_at: string;
  priority: number;
  status: string;
  created_at: string;
}

export interface Reminder {
  taskId: string;
  kind: ReminderKind;
  /** Epoch millis the reminder is scheduled for. */
  at: number;
  /** `{task_id}:{kind}:{scheduled_for_iso}` — see §6.5. */
  fireKey: string;
  /** Human text for the notification body, e.g. "Due in 15 minutes". */
  body: string;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Lead offsets before `due_at`, earliest first (§6.2). */
const LEAD_OFFSETS: Record<ReminderScope, number[]> = {
  day: [HOUR, 15 * MINUTE],
  week: [DAY, 3 * HOUR],
  month: [3 * DAY, DAY],
};

const HIGH_PRIORITY_EXTRA_LEAD = 5 * MINUTE;
const OVERDUE_NAG_INTERVAL = 4 * HOUR;

export function fireKey(taskId: string, kind: ReminderKind, at: number) {
  return `${taskId}:${kind}:${new Date(at).toISOString()}`;
}

export function digestFireKey(userId: string, localDate: string) {
  return `${userId}:digest:${localDate}`;
}

function describeOffset(ms: number): string {
  if (ms % DAY === 0) {
    const d = ms / DAY;
    return d === 1 ? "tomorrow" : `in ${d} days`;
  }
  if (ms % HOUR === 0) {
    const h = ms / HOUR;
    return h === 1 ? "in 1 hour" : `in ${h} hours`;
  }
  const m = Math.round(ms / MINUTE);
  return m === 1 ? "in 1 minute" : `in ${m} minutes`;
}

/** The lead offsets that apply to a task once priority is factored in. */
export function leadOffsets(scope: ReminderScope, priority: number): number[] {
  let offsets = [...LEAD_OFFSETS[scope]];
  if (priority <= 0) offsets = offsets.slice(1);
  if (priority >= 2) offsets.push(HIGH_PRIORITY_EXTRA_LEAD);
  return offsets.sort((a, b) => b - a);
}

/**
 * Every lead + due reminder for a task, regardless of whether it is in the
 * past. Reminders scheduled before the task existed are dropped — creating a
 * task due in 10 minutes must not immediately fire its "due in 1 hour" lead.
 */
export function scheduledReminders(task: ReminderTask): Reminder[] {
  if (task.status !== "open") return [];
  const due = new Date(task.due_at).getTime();
  const created = new Date(task.created_at).getTime();

  const out: Reminder[] = leadOffsets(task.scope, task.priority).map(
    (offset) => {
      const at = due - offset;
      return {
        taskId: task.id,
        kind: "lead",
        at,
        fireKey: fireKey(task.id, "lead", at),
        body: `Due ${describeOffset(offset)}`,
      };
    },
  );
  out.push({
    taskId: task.id,
    kind: "due",
    at: due,
    fireKey: fireKey(task.id, "due", due),
    body: "Due now",
  });

  return out.filter((r) => r.at >= created);
}

/**
 * The repeating overdue nag — high priority only (§6.2). Normal overdue tasks
 * are folded into the morning digest instead of pinging individually.
 * Returns the most recent nag slot at or before `now`, if any.
 */
export function latestOverdueNag(
  task: ReminderTask,
  now: number,
): Reminder | null {
  if (task.status !== "open" || task.priority < 2) return null;
  const due = new Date(task.due_at).getTime();
  const k = Math.floor((now - due) / OVERDUE_NAG_INTERVAL);
  if (k < 1) return null;
  const at = due + k * OVERDUE_NAG_INTERVAL;
  return {
    taskId: task.id,
    kind: "overdue",
    at,
    fireKey: fireKey(task.id, "overdue", at),
    body: "Overdue — still open",
  };
}

// ─────────────────────────────────────────────────────────
// Timezone helpers (Intl-based, DST-safe)
// ─────────────────────────────────────────────────────────

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Validates an IANA zone name, falling back to UTC for garbage input. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    formatterFor(timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

export function localParts(at: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in the given zone. */
export function localDate(at: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes since local midnight. */
export function localMinuteOfDay(at: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  return p.hour * 60 + p.minute;
}

/** Parses Postgres `time` ("08:00" or "08:00:00") into minutes since midnight. */
export function parseTimeOfDay(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Offset of the zone from UTC at a given instant, in millis. */
function zoneOffset(at: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(at / MINUTE) * MINUTE;
}

/** The instant of the next local midnight after `at`. */
export function endOfLocalDay(at: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  const naive = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0);
  // Two passes settle the offset even when midnight straddles a DST change.
  let guess = naive - zoneOffset(naive, timeZone);
  guess = naive - zoneOffset(guess, timeZone);
  return guess;
}

/**
 * Whether `minute` (minutes since local midnight) falls in [start, end),
 * handling ranges that wrap past midnight like 22:00–07:00.
 */
export function minuteInRange(minute: number, start: number, end: number) {
  if (start === end) return false;
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

export interface QuietHours {
  timeZone: string;
  start: string;
  end: string;
}

export function inQuietHours(at: number, quiet: QuietHours): boolean {
  return minuteInRange(
    localMinuteOfDay(at, quiet.timeZone),
    parseTimeOfDay(quiet.start),
    parseTimeOfDay(quiet.end),
  );
}

/**
 * §6.4: drop reminders during quiet hours, except high-priority tasks that
 * are themselves due during quiet hours.
 */
export function suppressedByQuietHours(
  reminder: Reminder,
  task: ReminderTask,
  quiet: QuietHours,
): boolean {
  if (!inQuietHours(reminder.at, quiet)) return false;
  if (task.priority >= 2 && inQuietHours(new Date(task.due_at).getTime(), quiet)) {
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────
// Digest (§6.3)
// ─────────────────────────────────────────────────────────

/** How long after `digest_time` the digest may still go out if a sweep was missed. */
export const DIGEST_WINDOW_MINUTES = 30;

/**
 * If `now` is inside the user's digest window, returns the local date the
 * window *started* on — the digest's dedup key. Keying on the start date
 * keeps a 23:50 digest from sending again after midnight.
 */
export function digestWindowDate(
  now: number,
  timeZone: string,
  digestTime: string,
): string | null {
  const start = parseTimeOfDay(digestTime);
  const minute = localMinuteOfDay(now, timeZone);
  const sinceStart = (minute - start + 24 * 60) % (24 * 60);
  if (sinceStart >= DIGEST_WINDOW_MINUTES) return null;
  return localDate(now - sinceStart * MINUTE, timeZone);
}

export interface DigestCounts {
  overdue: number;
  today: number;
  week: number;
}

export function digestCounts(
  tasks: ReminderTask[],
  now: number,
  timeZone: string,
): DigestCounts {
  const endToday = endOfLocalDay(now, timeZone);
  const endWeek = now + 7 * DAY;
  const counts: DigestCounts = { overdue: 0, today: 0, week: 0 };
  for (const t of tasks) {
    if (t.status !== "open") continue;
    const due = new Date(t.due_at).getTime();
    if (due < now) counts.overdue++;
    else if (due < endToday) counts.today++;
    else if (due < endWeek) counts.week++;
  }
  return counts;
}

export function digestMessage(c: DigestCounts): {
  title: string;
  body: string;
  view: "overdue" | "day" | "week";
} | null {
  const total = c.overdue + c.today + c.week;
  if (total === 0) return null;
  const parts = [
    c.overdue && `${c.overdue} overdue`,
    c.today && `${c.today} due today`,
    c.week && `${c.week} this week`,
  ].filter(Boolean);
  return {
    title: `${total} ${total === 1 ? "task needs" : "tasks need"} attention`,
    body: parts.join(" · "),
    view: c.overdue ? "overdue" : c.today ? "day" : "week",
  };
}
