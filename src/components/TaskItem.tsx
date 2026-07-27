"use client";

import { useState } from "react";
import type { Task, TaskInput } from "@/lib/tasks";
import TaskForm from "./TaskForm";

interface TaskItemProps {
  task: Task;
  now: number;
  onToggle: (task: Task) => Promise<void>;
  onUpdate: (id: string, input: TaskInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const PRIORITY_LABEL = ["Low", "Normal", "High"];

function formatDue(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function TaskItem({
  task,
  now,
  onToggle,
  onUpdate,
  onDelete,
}: TaskItemProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const isDone = task.status === "done";
  const isOverdue = !isDone && new Date(task.due_at).getTime() < now;

  if (editing) {
    return (
      <TaskForm
        initial={task}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={async (input) => {
          await onUpdate(task.id, input);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <input
        type="checkbox"
        checked={isDone}
        disabled={busy}
        onChange={async () => {
          setBusy(true);
          try {
            await onToggle(task);
          } finally {
            setBusy(false);
          }
        }}
        className="mt-1 h-4 w-4"
      />
      <div className="flex-1">
        <p
          className={`text-sm font-medium ${
            isDone
              ? "text-zinc-400 line-through"
              : "text-zinc-900 dark:text-zinc-50"
          }`}
        >
          {task.title}
        </p>
        {task.notes && <p className="text-xs text-zinc-500">{task.notes}</p>}
        <p
          className={`mt-1 text-xs ${
            isOverdue ? "font-medium text-red-600" : "text-zinc-400"
          }`}
        >
          Due {formatDue(task.due_at)} · {PRIORITY_LABEL[task.priority]}{" "}
          priority
          {isOverdue && " · Overdue"}
        </p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => setEditing(true)}
          className="text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
        >
          Edit
        </button>
        <button
          onClick={async () => {
            if (!confirm(`Delete "${task.title}"?`)) return;
            setBusy(true);
            try {
              await onDelete(task.id);
            } finally {
              setBusy(false);
            }
          }}
          className="text-xs font-medium text-red-500 hover:text-red-700"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
