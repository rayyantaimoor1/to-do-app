export type TaskScope = "day" | "week" | "month";
export type TaskStatus = "open" | "done";
export type TaskPriority = 0 | 1 | 2;

export interface Task {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  scope: TaskScope;
  due_at: string;
  priority: TaskPriority;
  status: TaskStatus;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskInput {
  title: string;
  notes: string | null;
  scope: TaskScope;
  due_at: string;
  priority: TaskPriority;
}
