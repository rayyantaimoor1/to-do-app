import { supabase } from "@/lib/supabase";
import { db } from "@/lib/db";
import { requestFlush } from "@/lib/sync";
import type { Task, TaskInput, TaskStatus } from "@/lib/types";

export type {
  Task,
  TaskInput,
  TaskScope,
  TaskStatus,
  TaskPriority,
} from "@/lib/types";

async function currentUserId(): Promise<string> {
  // Reads the persisted session, so this still resolves while offline.
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new Error("Not signed in");
  return userId;
}

/**
 * Every mutation below writes to Dexie and enqueues the outbox entry inside
 * a single transaction. If those two could diverge, the local cache and the
 * queued intent would disagree and the divergence would survive a reload.
 */

export async function createTask(input: TaskInput): Promise<Task> {
  const userId = await currentUserId();
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    user_id: userId,
    title: input.title,
    notes: input.notes,
    scope: input.scope,
    due_at: input.due_at,
    priority: input.priority,
    status: "open",
    completed_at: null,
    created_at: now,
    updated_at: now,
  };

  await db.transaction("rw", db.tasks, db.outbox, async () => {
    await db.tasks.put(task);
    await db.outbox.add({
      op: "create",
      taskId: task.id,
      payload: { ...task },
      createdAt: now,
      attempts: 0,
      lastError: null,
    });
  });

  void requestFlush();
  return task;
}

export async function updateTask(
  id: string,
  patch: Partial<TaskInput>,
): Promise<void> {
  const now = new Date().toISOString();

  await db.transaction("rw", db.tasks, db.outbox, async () => {
    const existing = await db.tasks.get(id);
    if (!existing) throw new Error("Task not found");
    await db.tasks.put({ ...existing, ...patch, updated_at: now });
    await db.outbox.add({
      op: "update",
      taskId: id,
      payload: { ...patch, updated_at: now },
      createdAt: now,
      attempts: 0,
      lastError: null,
    });
  });

  void requestFlush();
}

export async function setTaskStatus(
  id: string,
  status: TaskStatus,
): Promise<void> {
  const now = new Date().toISOString();
  const completedAt = status === "done" ? now : null;

  await db.transaction("rw", db.tasks, db.outbox, async () => {
    const existing = await db.tasks.get(id);
    if (!existing) throw new Error("Task not found");
    await db.tasks.put({
      ...existing,
      status,
      completed_at: completedAt,
      updated_at: now,
    });
    await db.outbox.add({
      op: "update",
      taskId: id,
      payload: { status, completed_at: completedAt, updated_at: now },
      createdAt: now,
      attempts: 0,
      lastError: null,
    });
  });

  void requestFlush();
}

export async function deleteTask(id: string): Promise<void> {
  const now = new Date().toISOString();

  await db.transaction("rw", db.tasks, db.outbox, async () => {
    await db.tasks.delete(id);
    await db.outbox.add({
      op: "delete",
      taskId: id,
      payload: null,
      createdAt: now,
      attempts: 0,
      lastError: null,
    });
  });

  void requestFlush();
}
