"use client";

import { useEffect, useRef, useState } from "react";
import type { Task, TaskInput } from "@/lib/tasks";
import TaskForm from "./TaskForm";

interface TaskItemProps {
  task: Task;
  now: number;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onToggle: (task: Task) => Promise<void>;
  onUpdate: (id: string, input: TaskInput) => Promise<void>;
  onDelete: (task: Task) => Promise<void>;
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
  selected,
  editing,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onToggle,
  onUpdate,
  onDelete,
}: TaskItemProps) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isDone = task.status === "done";
  const isOverdue = !isDone && new Date(task.due_at).getTime() < now;

  // Keyboard navigation (j/k) can move the selection off-screen.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (editing) {
    return (
      <TaskForm
        initial={task}
        submitLabel="Save"
        onCancel={onCancelEdit}
        onSubmit={(input) => onUpdate(task.id, input)}
      />
    );
  }

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-lg border bg-white p-3 dark:bg-zinc-900 ${
        selected
          ? "border-indigo-400 ring-2 ring-indigo-200 dark:border-indigo-500 dark:ring-indigo-900"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <input
        type="checkbox"
        aria-label={isDone ? "Mark as not done" : "Mark as done"}
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
      <div className="min-w-0 flex-1">
        <p
          className={`break-words text-sm font-medium ${
            isDone
              ? "text-zinc-400 line-through"
              : "text-zinc-900 dark:text-zinc-50"
          }`}
        >
          {task.title}
        </p>
        {task.notes && (
          <p className="break-words text-xs text-zinc-500">{task.notes}</p>
        )}
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
          onClick={onStartEdit}
          className="text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
        >
          Edit
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onDelete(task);
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
