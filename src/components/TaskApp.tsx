"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import {
  createTask,
  deleteTask,
  fetchTasks,
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

export default function TaskApp({ session }: { session: Session }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("day");
  const [showCompleted, setShowCompleted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetchTasks()
      .then((data) => {
        if (!cancelled) setTasks(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load tasks");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    return tasks
      .filter((t) => {
        const dueTime = new Date(t.due_at).getTime();
        const isOverdue = t.status === "open" && dueTime < now;
        if (view === "overdue") return isOverdue;
        if (isOverdue) return false;
        if (t.status === "done" && !showCompleted) return false;
        return dueTime <= now + HORIZON_MS[view];
      })
      .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
  }, [tasks, view, showCompleted, now]);

  const handleCreate = async (input: TaskInput) => {
    const task = await createTask(input);
    setTasks((prev) => [...prev, task]);
    setCreating(false);
  };

  const handleUpdate = async (id: string, input: TaskInput) => {
    const updated = await updateTask(id, input);
    setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
  };

  const handleToggle = async (task: Task) => {
    const updated = await setTaskStatus(
      task.id,
      task.status === "done" ? "open" : "done",
    );
    setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
  };

  const handleDelete = async (id: string) => {
    await deleteTask(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
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
        <button
          onClick={() => supabase.auth.signOut()}
          className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
        >
          Sign out
        </button>
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

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
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
