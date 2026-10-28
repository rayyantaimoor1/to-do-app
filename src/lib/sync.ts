import { supabase } from "@/lib/supabase";
import { db, getMeta, setMeta, LAST_SYNC_KEY, type OutboxEntry } from "@/lib/db";
import { loadProfile } from "@/lib/profile";
import type { Task } from "@/lib/types";

/**
 * Give up on an entry after this many failures so one permanently-rejected
 * write (e.g. a row RLS will never accept) can't wedge the queue forever.
 */
const MAX_ATTEMPTS = 5;

const isOnline = () =>
  typeof navigator === "undefined" ? true : navigator.onLine;

/**
 * Timestamps arrive in two different shapes — PostgREST returns
 * `2026-07-27T10:43:00.123456+00:00` while local writes use
 * `Date.toISOString()` (`...123Z`). Lexicographic comparison would be
 * wrong across those formats, so always compare parsed epoch millis.
 */
const olderThan = (a: string, b: string) =>
  new Date(a).getTime() < new Date(b).getTime();

// PostgrestError is a plain object with `message`, not always an Error.
const errorMessage = (err: unknown) =>
  (err as { message?: string })?.message ?? String(err);

/**
 * Sync problems the user should hear about (the UI shows them as toasts).
 * Transient failures stay quiet — the outbox retries them — so this only
 * fires when a change is discarded or a resync fails while online.
 */
export const syncEvents = new EventTarget();
export type SyncErrorEvent = CustomEvent<string>;

let lastReport = { message: "", at: 0 };

function reportSyncError(message: string) {
  // Resync runs on every reconnect and every return to the app; repeating
  // the same failure each time would just be noise.
  const now = Date.now();
  if (message === lastReport.message && now - lastReport.at < 5 * 60_000) return;
  lastReport = { message, at: now };
  syncEvents.dispatchEvent(new CustomEvent("error", { detail: message }));
}

function describeSyncFailure(err: unknown): string {
  const msg = errorMessage(err);
  if (/failed to fetch|network|load failed/i.test(msg)) {
    return "Can't reach the server. Your changes are saved on this device and will sync when it's back.";
  }
  return `Sync failed: ${msg}`;
}

// ─────────────────────────────────────────────────────────
// Local data ownership
// ─────────────────────────────────────────────────────────

const OWNER_KEY = "owner_user_id";

/**
 * IndexedDB is per-browser, not per-account. If a different user signs in
 * here, the previous user's tasks, queued writes and sync watermark must not
 * leak into their session: the outbox would replay A's edits as B, and A's
 * watermark would make B's first reconcile skip most of B's tasks.
 */
async function claimLocalData(userId: string): Promise<void> {
  const owner = await getMeta(OWNER_KEY);
  if (owner === userId) return;
  if (owner) await clearLocalData();
  await setMeta(OWNER_KEY, userId);
}

export async function clearLocalData(): Promise<void> {
  await db.transaction("rw", db.tasks, db.outbox, db.meta, async () => {
    await db.tasks.clear();
    await db.outbox.clear();
    await db.meta.clear();
  });
}

// ─────────────────────────────────────────────────────────
// Outbox flush
// ─────────────────────────────────────────────────────────

/**
 * Serialized flush chain.
 *
 * Callers get a promise that resolves only once the queue has actually
 * drained — including work started by an earlier call. An
 * "already running, return immediately" shortcut would break `resync`:
 * it would proceed to reconcile while inserts were still in flight, and
 * the deletion pass would then see a locally-created row missing from the
 * server's id list and delete it.
 */
let flushChain: Promise<void> = Promise.resolve();

export function requestFlush(): Promise<void> {
  if (!isOnline()) return Promise.resolve();
  flushChain = flushChain.then(() =>
    flushOutbox().catch((err) => {
      console.error("Outbox flush failed:", err);
    }),
  );
  return flushChain;
}

async function flushOutbox(): Promise<void> {
  for (;;) {
    const entry = await db.outbox.orderBy("seq").first();
    if (!entry) return;

    try {
      await pushEntry(entry);
      await db.outbox.delete(entry.seq);
    } catch (err) {
      if (!isPermanentFailure(err)) {
        // Unreachable server, 5xx, expired token: nothing is wrong with the
        // write itself. Keep it, don't count it, and try again on the next
        // flush. Counting these used to discard real edits after a few
        // minutes of outage while navigator.onLine still said "online".
        await db.outbox.update(entry.seq, { lastError: errorMessage(err) });
        return;
      }
      const attempts = entry.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        console.error(
          `Dropping outbox entry after ${attempts} attempts:`,
          entry,
          err,
        );
        await db.outbox.delete(entry.seq);
        reportSyncError(
          `A change couldn't be saved and was discarded: ${errorMessage(err)}`,
        );
        continue;
      }
      await db.outbox.update(entry.seq, {
        attempts,
        lastError: errorMessage(err),
      });
      // Stop rather than skip ahead: replaying later edits before earlier
      // ones is exactly the corruption the seq ordering exists to prevent.
      return;
    }
  }
}

/** A write the server answered and refused, carrying the HTTP status. */
class RejectedWrite extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Only a 4xx the server actually sent says the write itself is bad (RLS,
 * check constraint...). A network failure comes back from supabase-js as
 * status 0; 401 means the token needs refreshing; 408/429 are "later".
 */
function isPermanentFailure(err: unknown): boolean {
  return (
    err instanceof RejectedWrite &&
    err.status >= 400 &&
    err.status < 500 &&
    ![401, 408, 429].includes(err.status)
  );
}

function rejected(error: { message: string }, status: number): RejectedWrite {
  return new RejectedWrite(error.message, status);
}

async function pushEntry(entry: OutboxEntry): Promise<void> {
  if (entry.op === "create") {
    const { data, error, status } = await supabase
      .from("tasks")
      .insert(entry.payload!)
      .select()
      .single();
    if (error?.code === "23505") {
      // Already there: an earlier attempt reached the server but its
      // response was lost. The insert succeeded — adopt the server row.
      const { data: existing, error: readError, status: readStatus } =
        await supabase.from("tasks").select("*").eq("id", entry.taskId).single();
      if (readError) throw rejected(readError, readStatus);
      await db.tasks.put(existing as Task);
      return;
    }
    if (error) throw rejected(error, status);
    // Take the server row verbatim. Its updated_at comes from the DB trigger,
    // so adopting it here keeps every later comparison server-clock-based and
    // immune to skew on this machine.
    await db.tasks.put(data as Task);
    return;
  }

  if (entry.op === "update") {
    const { data, error, status } = await supabase
      .from("tasks")
      .update(entry.payload!)
      .eq("id", entry.taskId)
      .select()
      .maybeSingle();
    if (error) throw rejected(error, status);
    // maybeSingle: the row may have been deleted on another device. That's
    // not an error — the delete simply won.
    if (data) await db.tasks.put(data as Task);
    return;
  }

  const { error, status } = await supabase
    .from("tasks")
    .delete()
    .eq("id", entry.taskId);
  if (error) throw rejected(error, status);
}

// ─────────────────────────────────────────────────────────
// Remote → local merge (last-write-wins)
// ─────────────────────────────────────────────────────────

async function hasPending(taskId: string): Promise<boolean> {
  return (await db.outbox.where("taskId").equals(taskId).count()) > 0;
}

export async function mergeRemoteTask(remote: Task): Promise<void> {
  await db.transaction("rw", db.tasks, db.outbox, async () => {
    // A queued local edit hasn't reached the server yet. Letting the remote
    // row overwrite it here would make the UI flap back to the old value and
    // then forward again the moment the flush lands.
    if (await hasPending(remote.id)) return;

    const local = await db.tasks.get(remote.id);
    if (!local || !olderThan(remote.updated_at, local.updated_at)) {
      await db.tasks.put(remote);
    }
  });
}

async function applyRemoteDelete(id: string): Promise<void> {
  await db.transaction("rw", db.tasks, db.outbox, async () => {
    if (await hasPending(id)) return;
    await db.tasks.delete(id);
  });
}

// ─────────────────────────────────────────────────────────
// Reconciliation
// ─────────────────────────────────────────────────────────

export async function reconcile(userId: string): Promise<void> {
  const watermark = await getMeta(LAST_SYNC_KEY);

  let query = supabase.from("tasks").select("*").eq("user_id", userId);
  if (watermark) query = query.gt("updated_at", watermark);
  const { data: changed, error } = await query;
  if (error) throw error;

  const rows = (changed ?? []) as Task[];
  for (const row of rows) {
    await mergeRemoteTask(row);
  }

  // The watermark query can only see rows that still exist, so a row deleted
  // on another device while this one was offline would linger locally forever.
  // Compare the full id set to catch those.
  const { data: idRows, error: idError } = await supabase
    .from("tasks")
    .select("id")
    .eq("user_id", userId);
  if (idError) throw idError;
  const remoteIds = new Set((idRows ?? []).map((r) => r.id as string));

  const localTasks = await db.tasks.toArray();
  for (const local of localTasks) {
    if (remoteIds.has(local.id)) continue;
    await applyRemoteDelete(local.id);
  }

  // Advance the watermark using the newest *server* timestamp observed, never
  // this device's clock.
  const newest = rows.reduce<string | null>(
    (max, r) => (!max || olderThan(max, r.updated_at) ? r.updated_at : max),
    watermark,
  );
  if (newest) await setMeta(LAST_SYNC_KEY, newest);
}

// ─────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────

async function resync(userId: string, ready: Promise<void>): Promise<void> {
  await ready;
  if (!isOnline()) return;
  try {
    // Push local intent before pulling remote state, so reconcile sees a
    // server that already reflects this device's edits.
    await requestFlush();
    await reconcile(userId);
    // Settings changed on another device (quiet hours, digest time) must
    // reach this one's cache too — local alarms read it.
    await loadProfile(userId);
  } catch (err) {
    console.error("Resync failed:", err);
    // navigator.onLine can be true on a captive or flaky network; only
    // bother the user when we still believe we're connected.
    if (isOnline()) reportSyncError(describeSyncFailure(err));
  }
}

export function startSync(userId: string): () => void {
  const ready = claimLocalData(userId).catch((err) => {
    console.error("Couldn't prepare local data:", err);
  });

  const channel = supabase
    .channel(`tasks:${userId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "tasks",
        filter: `user_id=eq.${userId}`,
      },
      async (payload) => {
        await ready;
        if (payload.eventType !== "DELETE") {
          await mergeRemoteTask(payload.new as Task);
        }
      },
    )
    // Realtime can't evaluate a column filter against a deleted row (the old
    // record carries only the primary key), so a `user_id=eq.` subscription
    // never receives DELETEs. Listen to deletes unfiltered instead. Postgres
    // can't apply RLS to a row that no longer exists, so this channel may
    // also see other users' deleted ids — bare UUIDs with no content, and
    // applyRemoteDelete is a no-op for ids that aren't in this device's cache.
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "tasks" },
      async (payload) => {
        await ready;
        const id = (payload.old as { id?: string })?.id;
        if (id) await applyRemoteDelete(id);
      },
    )
    .subscribe((status) => {
      // Fires on first connect and again after any reconnect, which is
      // precisely when the gap needs filling.
      if (status === "SUBSCRIBED") void resync(userId, ready);
    });

  const onOnline = () => void resync(userId, ready);
  const onVisibility = () => {
    if (document.visibilityState === "visible") void resync(userId, ready);
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);

  void resync(userId, ready);

  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
    void supabase.removeChannel(channel);
  };
}
