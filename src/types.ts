export type Effort = "small" | "medium" | "large";

export interface Action {
  text: string;
  effort: Effort;
}

export interface SavePayload {
  title: string;
  url?: string;
  source: string;
  summary: string;
  actions: Action[];
  intent?: string;
}

export interface TaskPayload {
  title: string;
  raw: string;
  details: { question: string; answer: string }[];
  plan: string[];
}

export type ItemKind = "save" | "task";
// draft: waiting for the user's intent; open: scheduled; quiet: stopped
// nudging after no answer; the rest are closed.
export type ItemStatus = "draft" | "open" | "quiet" | "done" | "dropped";

export interface Item {
  id: number;
  userId: number;
  kind: ItemKind;
  status: ItemStatus;
  payload: SavePayload | TaskPayload;
  gapDays: number;
  dueAt: Date | null;
  nextAt: Date | null;
  nudgeCount: number;
  lastNudgedAt: Date | null;
  createdAt: Date;
}

export interface TaskDraft {
  title: string;
  raw: string;
  date?: string; // YYYY-MM-DD in the user's zone
  time?: string; // HH:mm in the user's zone
  questions: string[];
  details: { question: string; answer: string }[];
  rescheduleItemId?: number;
}

// What the bot is waiting for from this user. Stored encrypted.
export type Pending =
  | { kind: "timezone" }
  | { kind: "connect_account" }
  | { kind: "connect_key"; accountId: string }
  | { kind: "save_intent"; itemId: number }
  | { kind: "save_gap"; itemId: number }
  | { kind: "paste_for"; url: string }
  | { kind: "task_when"; draft: TaskDraft }
  | { kind: "task_time"; draft: TaskDraft }
  | { kind: "task_question"; draft: TaskDraft; index: number }
  | { kind: "nudge_reply"; itemId: number }
  | { kind: "gap_custom" };

export interface MemwalCreds {
  accountId: string;
  key: string;
}

export interface User {
  id: number;
  chatId: number;
  firstName: string;
  timezone: string | null;
  defaultGapDays: number;
  creds: MemwalCreds | null;
  pending: Pending | null;
}

export interface Button {
  text: string;
  data?: string;
  url?: string;
}

export interface Content {
  title: string;
  text: string;
  source: string;
  url?: string;
}
