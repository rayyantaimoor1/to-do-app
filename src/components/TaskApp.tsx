"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { Session } from "@supabase/supabase-js";
import { db } from "@/lib/db";
import { startSync, syncEvents, type SyncErrorEvent } from "@/lib/sync";
import {
  enableNotifications,
  notificationState,
  refreshNotifications,
  type PushState,
} from "@/lib/push";
import { signOut, unsyncedChanges } from "@/lib/session";
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
import Settings from "./Settings";
import NativeBridge from "./NativeBridge";
import ShortcutHelp from "./ShortcutHelp";

type View = TaskScope | "overdue";

const VIEWS: { key: View; label: string; empty: string }[] = [
  { key: "day", label: "Today", empty: "Nothing due in the next 24 hours." },
  { key: "week", label: "This Week", empty: "Nothing due in the next 7 days." },
  {
    key: "month",
    label: "This Month",
    empty: "Nothing due in the next 30 days.",
  },
  { key: "overdue", label: "Overdue", empty: "Nothing overdue. Nice." },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const HORIZON_MS: Record<TaskScope, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

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

/** Typing in a field must not trigger single-key shortcuts. */
function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
}

export default function TaskApp({ session }: { session: Session }) {
  // TaskApp only mounts after the session resolves on the client, so
  // `window` is always available here.
  const [view, setView] = useState<View>(
    () => viewFromUrl(window.location.href) ?? "day",
  );
  const [query, setQuery] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushState>("unsupported");
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);

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
    refreshNotifications()
      .catch((err) => console.error("Push refresh failed:", err))
      .finally(() => notificationState().then(setPushState));
  }, [userId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onError = (e: Event) => setToast((e as SyncErrorEvent).detail);
    syncEvents.addEventListener("error", onError);
    return () => syncEvents.removeEventListener("error", onError);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const openUrl = useCallback((url: string) => {
    const v = viewFromUrl(url);
    if (!v) return;
    setView(v);
    setQuery("");
    setShowSettings(false);
  }, []);

  // A notification tapped while the app is already open: the service worker
  // focuses this window and tells it which view to show.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-url") openUrl(e.data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [openUrl]);

  const searching = query.trim().length > 0;

  const visibleTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tasks ?? [])
      .filter((t) => {
        if (q) {
          // Search spans every view, so a task is findable wherever it is.
          if (t.status === "done" && !showCompleted) return false;
          return (
            t.title.toLowerCase().includes(q) ||
            (t.notes ?? "").toLowerCase().includes(q)
          );
        }
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
  }, [tasks, view, query, showCompleted, now]);

  // Derived from the visible list, so a filter change can't leave the
  // keyboard selection pointing at a hidden row.
  const selected = visibleTasks.find((t) => t.id === selectedId) ?? null;

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Something went wrong");
    }
  }, []);

  const enableReminders = useCallback(async () => {
    try {
      setPushState(await enableNotifications());
    } catch (err) {
      setToast(
        err instanceof Error ? err.message : "Couldn't enable reminders",
      );
    }
  }, []);

  const handleCreate = async (input: TaskInput) => {
    await run(() => createTask(input));
    setCreating(false);
    // §6.7: ask for notification permission on first task creation, not on
    // launch — that's when the user can see why it's needed.
    if (pushState === "default") void enableReminders();
  };

  const handleUpdate = async (id: string, input: TaskInput) => {
    await run(() => updateTask(id, input));
    setEditingId(null);
  };

  const handleToggle = useCallback(
    (task: Task) =>
      run(() =>
        setTaskStatus(task.id, task.status === "done" ? "open" : "done"),
      ),
    [run],
  );

  const handleDelete = useCallback(
    async (task: Task) => {
      if (!confirm(`Delete "${task.title}"?`)) return;
      await run(() => deleteTask(task.id));
    },
    [run],
  );

  const handleSignOut = useCallback(
    async (scope: "local" | "global") => {
      const unsynced = await unsyncedChanges();
      const lose =
        unsynced > 0
          ? `\n\n${unsynced} change(s) on this device haven't synced yet and will be lost.`
          : "";
      const what =
        scope === "global"
          ? "Sign out on every device? Each one will need to sign in again, and reminders stop on all of them."
          : "Sign out on this device?";
      if (!confirm(what + lose)) return;
      await run(() => signOut(scope));
    },
    [run],
  );

  // ───────────────────────────────────────────────────────
  // Keyboard shortcuts (desktop) — see ShortcutHelp
  // ───────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "Escape") {
        if (showHelp) setShowHelp(false);
        else if (editingId) setEditingId(null);
        else if (creating) setCreating(false);
        else if (showSettings) setShowSettings(false);
        else if (query) setQuery("");
        else return;
        (document.activeElement as HTMLElement | null)?.blur();
        e.preventDefault();
        return;
      }
      if (isTypingTarget(e.target) || editingId || creating) return;

      const moveSelection = (delta: number) => {
        if (!visibleTasks.length) return;
        const i = selected ? visibleTasks.indexOf(selected) : -1;
        const next = Math.min(
          visibleTasks.length - 1,
          Math.max(0, i + delta),
        );
        setSelectedId(visibleTasks[next].id);
      };

      const actions: Record<string, () => void> = {
        "?": () => setShowHelp((s) => !s),
        n: () => {
          setShowSettings(false);
          setCreating(true);
        },
        "/": () => {
          setShowSettings(false);
          // Focus after the list (not settings) has rendered.
          setTimeout(() => searchRef.current?.focus(), 0);
        },
        s: () => setShowSettings((s) => !s),
        "1": () => setView("day"),
        "2": () => setView("week"),
        "3": () => setView("month"),
        "4": () => setView("overdue"),
        j: () => moveSelection(1),
        ArrowDown: () => moveSelection(1),
        k: () => moveSelection(-1),
        ArrowUp: () => moveSelection(-1),
        x: () => selected && void handleToggle(selected),
        e: () => selected && setEditingId(selected.id),
        Delete: () => selected && void handleDelete(selected),
        c: () => setShowCompleted((s) => !s),
      };

      // Some keyboards/automation report Shift+/ as "/" with shiftKey set.
      const key = e.key === "/" && e.shiftKey ? "?" : e.key;
      const action = actions[key];
      if (!action) return;
      if (showSettings && !["?", "s", "n", "/"].includes(key)) return;
      e.preventDefault();
      action();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    showHelp,
    editingId,
    creating,
    showSettings,
    query,
    visibleTasks,
    selected,
    handleToggle,
    handleDelete,
  ]);

  const emptyMessage = searching
    ? `No tasks match "${query.trim()}".`
    : VIEWS.find((v) => v.key === view)!.empty;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-8">
      <NativeBridge onOpenUrl={openUrl} />

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            To-Do App
          </h1>
          <p className="truncate text-xs text-zinc-500">{session.user.email}</p>
        </div>
        <div className="flex items-center gap-2">
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
            onClick={() => setShowSettings((s) => !s)}
            aria-pressed={showSettings}
            className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
          >
            Settings
          </button>
          <button
            onClick={() => void handleSignOut("local")}
            className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
          >
            Sign out
          </button>
        </div>
      </header>

      {showSettings ? (
        <Settings
          userId={userId}
          pushState={pushState}
          onEnableReminders={enableReminders}
          onSignOutEverywhere={() => handleSignOut("global")}
          onShowShortcuts={() => setShowHelp(true)}
          onClose={() => setShowSettings(false)}
        />
      ) : (
        <>
          <nav className="flex gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-900">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => {
                  setView(v.key);
                  setQuery("");
                }}
                className={`flex-1 whitespace-nowrap rounded-full px-2 py-1.5 text-xs font-medium transition-colors sm:text-sm ${
                  view === v.key && !searching
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
                }`}
              >
                {v.label}
              </button>
            ))}
          </nav>

          <input
            ref={searchRef}
            type="search"
            placeholder="Search tasks  ( / )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />

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
                className="shrink-0 rounded-full bg-indigo-700 px-3 py-1 font-medium text-white"
              >
                Enable reminders
              </button>
            </div>
          )}

          {searching && (
            <p className="text-xs text-zinc-500">
              {visibleTasks.length} result
              {visibleTasks.length === 1 ? "" : "s"} across all views
            </p>
          )}

          {tasks === undefined ? (
            <p className="text-sm text-zinc-500">Loading tasks...</p>
          ) : visibleTasks.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
              {emptyMessage}
              {!searching && !creating && (
                <>
                  {" "}
                  <button
                    onClick={() => setCreating(true)}
                    className="font-medium text-zinc-900 underline dark:text-zinc-100"
                  >
                    Add a task
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {visibleTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  now={now}
                  selected={selected?.id === task.id}
                  editing={editingId === task.id}
                  onSelect={() => setSelectedId(task.id)}
                  onStartEdit={() => setEditingId(task.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onToggle={handleToggle}
                  onUpdate={handleUpdate}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}

          <p className="hidden text-center text-xs text-zinc-400 sm:block">
            Press <kbd className="font-mono">?</kbd> for keyboard shortcuts
          </p>
        </>
      )}

      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}

      {toast && (
        <div
          role="alert"
          className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md items-start gap-3 rounded-lg bg-zinc-900 px-4 py-3 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
        >
          <span className="flex-1">{toast}</span>
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="text-zinc-400 hover:text-white dark:hover:text-zinc-900"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
