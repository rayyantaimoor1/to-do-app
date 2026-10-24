"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { db } from "@/lib/db";
import { startSync } from "@/lib/sync";
import {
  enableWebPush,
  refreshWebPush,
  webPushState,
  type PushState,
} from "@/lib/push";
import {
  createTask,
  deleteTask,
  setTaskStatus,
  updateTask,
  type Task,
  type TaskInput,
  type TaskScope,
} from "@/lib/tasks";
import TaskForm from "./TaskForm";
import TaskItem from "./TaskItem";

type View = TaskScope | "overdue";

const VIEWS: { key: View; label: string }[] = [
  { key: "day", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "overdue", label: "Overdue" },
];

const isView = (v: string | null): v is View =>
  v === "day" || v === "week" || v === "month" || v === "overdue";

/** Notifications link to `/?view=overdue` etc. (see reminder-sweep). */
function viewFromUrl(url: string): View | null {
  const v = new URL(url, "http://x").searchParams.get("view");
  return isView(v) ? v : null;
}

function subscribeToOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export default function TaskApp({ session }: { session: Session }) {
  const [error, setError] = useState<string | null>(null);
  // TaskApp only mounts after the session resolves on the client, so
  // `window` is always available here.
  const [view, setView] = useState<View>(
    () => viewFromUrl(window.location.href) ?? "day",
  );
  const [pushState, setPushState] = useState<PushState>("unsupported");
  const [showCompleted, setShowCompleted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Prerender has no `navigator`, so the server snapshot optimistically
  // reports online; the client corrects it on hydration.
  const online = useSyncExternalStore(
    subscribeToOnline,
    () => navigator.onLine,
    () => true,
  );

  // Reads come straight from IndexedDB and re-render on every local write,
  // so the UI never waits on the network.
  const tasks = useLiveQuery(() => db.tasks.toArray(), []);
  const pendingCount = useLiveQuery(() => db.outbox.count(), [], 0);

  const userId = session.user.id;

  useEffect(() => startSync(userId), [userId]);

  useEffect(() => {
    refreshWebPush()
      .catch((err) => console.error("Push refresh failed:", err))
      .finally(() => webPushState().then(setPushState));
  }, [userId]);

  // A notification tapped while the app is already open: the service worker
  // focuses this window and tells it which view to show.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== "open-url") return;
      const v = viewFromUrl(e.data.url);
      if (v) setView(v);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  const enableReminders = async () => {
    try {
      setPushState(await enableWebPush());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't enable reminders",
      );
    }
  };

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const visibleTasks = useMemo(() => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const HORIZON_MS: Record<Exclude<View, "overdue">, number> = {
      day: DAY_MS,
      week: 7 * DAY_MS,
      month: 30 * DAY_MS,
    };
    return (tasks ?? [])
      .filter((t) => {
        const dueTime = new Date(t.due_at).getTime();
        const isOverdue = t.status === "open" && dueTime < now;
        if (view === "overdue") return isOverdue;
        if (isOverdue) return false;
        if (t.status === "done" && !showCompleted) return false;
        return dueTime <= now + HORIZON_MS[view];
      })
      .sort(
        (a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime(),
      );
  }, [tasks, view, showCompleted, now]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  const handleCreate = async (input: TaskInput) => {
    await run(() => createTask(input));
    setCreating(false);
    // §6.7: ask for notification permission on first task creation, not on
    // launch — that's when the user can see why it's needed.
    if (pushState === "default") void enableReminders();
  };

  const handleUpdate = async (id: string, input: TaskInput) => {
    await run(() => updateTask(id, input));
  };

  const handleToggle = async (task: Task) => {
    await run(() =>
      setTaskStatus(task.id, task.status === "done" ? "open" : "done"),
    );
  };

  const handleDelete = async (id: string) => {
    await run(() => deleteTask(id));
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            To-Do App
          </h1>
          <p className="text-xs text-zinc-500">{session.user.email}</p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-xs font-medium ${
              online ? "text-zinc-400" : "text-amber-600"
            }`}
            title={
              pendingCount
                ? `${pendingCount} change(s) waiting to sync`
                : undefined
            }
          >
            {online ? "Online" : "Offline"}
            {pendingCount ? ` · ${pendingCount} pending` : ""}
          </span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="flex gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-900">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`flex-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              view === v.key
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
            }`}
          >
            {v.label}
          </button>
        ))}
      </nav>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
          />
          Show completed
        </label>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            + New task
          </button>
        )}
      </div>

      {creating && (
        <TaskForm
          submitLabel="Add task"
          initial={{ scope: view === "overdue" ? "day" : view }}
          onCancel={() => setCreating(false)}
          onSubmit={handleCreate}
        />
      )}

      {pushState === "default" && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100">
          <span>Get reminders on this device before tasks are due.</span>
          <button
            onClick={enableReminders}
            className="rounded-full bg-indigo-700 px-3 py-1 font-medium text-white"
          >
            Enable reminders
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {tasks === undefined ? (
        <p className="text-sm text-zinc-500">Loading tasks...</p>
      ) : visibleTasks.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing here.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleTasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              now={now}
              onToggle={handleToggle}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
