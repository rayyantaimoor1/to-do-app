import { supabase } from "@/lib/supabase";
import { db, getMeta, setMeta, LAST_SYNC_KEY, type OutboxEntry } from "@/lib/db";
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
      const attempts = entry.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        console.error(
          `Dropping outbox entry after ${attempts} attempts:`,
          entry,
          err,
        );
        await db.outbox.delete(entry.seq);
        continue;
      }
      await db.outbox.update(entry.seq, {
        attempts,
        lastError: err instanceof Error ? err.message : String(err),
      });
      // Stop rather than skip ahead: replaying later edits before earlier
      // ones is exactly the corruption the seq ordering exists to prevent.
      return;
    }
  }
}

async function pushEntry(entry: OutboxEntry): Promise<void> {
  if (entry.op === "create") {
    const { data, error } = await supabase
      .from("tasks")
      .insert(entry.payload!)
      .select()
      .single();
    if (error) throw error;
    // Take the server row verbatim. Its updated_at comes from the DB trigger,
    // so adopting it here keeps every later comparison server-clock-based and
    // immune to skew on this machine.
    await db.tasks.put(data as Task);
    return;
  }

  if (entry.op === "update") {
    const { data, error } = await supabase
      .from("tasks")
      .update(entry.payload!)
      .eq("id", entry.taskId)
      .select()
      .maybeSingle();
    if (error) throw error;
    // maybeSingle: the row may have been deleted on another device. That's
    // not an error — the delete simply won.
    if (data) await db.tasks.put(data as Task);
    return;
  }

  const { error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", entry.taskId);
  if (error) throw error;
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

async function resync(userId: string): Promise<void> {
  if (!isOnline()) return;
  try {
    // Push local intent before pulling remote state, so reconcile sees a
    // server that already reflects this device's edits.
    await requestFlush();
    await reconcile(userId);
  } catch (err) {
    console.error("Resync failed:", err);
  }
}

export function startSync(userId: string): () => void {
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
      (payload) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string })?.id;
          if (id) void applyRemoteDelete(id);
        } else {
          void mergeRemoteTask(payload.new as Task);
        }
      },
    )
    .subscribe((status) => {
      // Fires on first connect and again after any reconnect, which is
      // precisely when the gap needs filling.
      if (status === "SUBSCRIBED") void resync(userId);
    });

  const onOnline = () => void resync(userId);
  const onVisibility = () => {
    if (document.visibilityState === "visible") void resync(userId);
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);

  void resync(userId);

  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
    void supabase.removeChannel(channel);
  };
}
