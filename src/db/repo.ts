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
export type UserPatch = Partial<Pick<User, "chatId" | "firstName" | "timezone" | "defaultGapDays" | "creds" | "pending" | "buddyId" | "buddyInvite" | "activeHours">>;

export interface OutboxEntry {
  id: number;
  userId: number;
  text: string;
  attempts: number;
}

// Text read from one photo of an album, waiting for the rest of the album.
export interface MediaPart {
  caption: string;
  text: string;
}

export interface UsageRow {
  userId: number;
  memories: number;
  saves: number;
  tasks: number;
  resolved: number;
}

export interface Repo {
  getUser(id: number): Promise<User | null>;
  ensureUser(id: number, chatId: number, firstName: string): Promise<User>;
  updateUser(id: number, patch: UserPatch): Promise<void>;
  listConnectedUserIds(): Promise<number[]>;
  findUserByBuddyInvite(token: string): Promise<User | null>;

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

  // Albums arrive as one update per photo. Each update records its part; the
  // last one to finish claims them all. claimMediaGroup returns null while a
  // part is still being read, or changed after quietSince, or was claimed.
  addMediaPart(userId: number, groupId: string, messageId: number, now: Date): Promise<void>;
  finishMediaPart(userId: number, groupId: string, messageId: number, part: MediaPart, now: Date): Promise<void>;
  claimMediaGroup(userId: number, groupId: string, quietSince: Date): Promise<MediaPart[] | null>;
  pruneMediaParts(before: Date): Promise<void>;

  // How many memories OctoKeep has written to each user's Walrus Memory.
  addMemoryCount(userId: number, n: number): Promise<void>;
  memoryCount(userId: number): Promise<number>;
  usageStats(): Promise<UsageRow[]>;

  markUpdateSeen(updateId: number): Promise<boolean>;
  pruneSeenUpdates(before: Date): Promise<void>;
}

export type { Item, Pending, MemwalCreds };
