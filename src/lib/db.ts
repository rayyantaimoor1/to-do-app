import Dexie, { type EntityTable } from "dexie";
import type { Task } from "@/lib/types";

export type OutboxOp = "create" | "update" | "delete";

/**
 * A queued mutation waiting to reach Supabase.
 *
 * `seq` is a Dexie auto-increment key, which is what guarantees the flush
 * order matches the order the user made the edits. Never write `seq` by
 * hand — out-of-order replay is exactly the corruption this table exists
 * to prevent.
 */
export interface OutboxEntry {
  seq: number;
  op: OutboxOp;
  taskId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export interface MetaEntry {
  key: string;
  value: string;
}

const db = new Dexie("todo-app") as Dexie & {
  tasks: EntityTable<Task, "id">;
  outbox: EntityTable<OutboxEntry, "seq">;
  meta: EntityTable<MetaEntry, "key">;
};

db.version(1).stores({
  tasks: "id, due_at, status, updated_at",
  outbox: "++seq, taskId, createdAt",
  meta: "key",
});

export { db };

export async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

export const LAST_SYNC_KEY = "last_sync_at";
