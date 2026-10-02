import type { Item, ItemKind, ItemStatus, MemwalCreds, Pending, User } from "../types.js";

export interface NewItem {
  userId: number;
  kind: ItemKind;
  status: ItemStatus;
  payload: Item["payload"];
  gapDays: number;
  dueAt?: Date | null;
  nextAt?: Date | null;
}

export type ItemPatch = Partial<Pick<Item, "status" | "payload" | "gapDays" | "dueAt" | "nextAt" | "nudgeCount" | "lastNudgedAt">>;
export type UserPatch = Partial<Pick<User, "chatId" | "firstName" | "timezone" | "defaultGapDays" | "creds" | "pending">>;

export interface OutboxEntry {
  id: number;
  userId: number;
  text: string;
  attempts: number;
}

export interface Repo {
  getUser(id: number): Promise<User | null>;
  ensureUser(id: number, chatId: number, firstName: string): Promise<User>;
  updateUser(id: number, patch: UserPatch): Promise<void>;
  listConnectedUserIds(): Promise<number[]>;

  createItem(item: NewItem): Promise<Item>;
  getItem(id: number, userId: number): Promise<Item | null>;
  updateItem(id: number, userId: number, patch: ItemPatch): Promise<void>;
  listItems(userId: number, statuses: ItemStatus[], kind?: ItemKind): Promise<Item[]>;
  // Leases due items so a second tick running at the same time skips them.
  claimDue(now: Date, leaseMs: number, limit: number, userId?: number): Promise<Item[]>;

  enqueueMemory(userId: number, text: string): Promise<number>;
  deleteOutbox(id: number): Promise<void>;
  claimOutbox(now: Date, limit: number): Promise<OutboxEntry[]>;
  failOutbox(id: number, error: string, nextTry: Date): Promise<void>;

  markUpdateSeen(updateId: number): Promise<boolean>;
  pruneSeenUpdates(before: Date): Promise<void>;
}

export type { Item, Pending, MemwalCreds };
