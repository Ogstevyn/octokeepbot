import type { Item, ItemKind, ItemStatus, User } from "../types.js";
import type { ItemPatch, MediaPart, NewItem, OutboxEntry, Repo, UserPatch } from "./repo.js";

// In-process implementation used by tests and by `DATABASE_URL=memory` for
// trying the bot locally without Postgres. Data is lost on restart.
export class MemoryRepo implements Repo {
  users = new Map<number, User>();
  items = new Map<number, Item>();
  outbox = new Map<number, OutboxEntry & { nextTry: Date }>();
  seen = new Map<number, Date>();
  parts = new Map<string, { userId: number; groupId: string; messageId: number; part: MediaPart | null; updatedAt: Date }>();
  private seq = 0;
  private outSeq = 0;

  private clone<T>(v: T): T {
    return structuredClone(v);
  }

  async getUser(id: number) {
    const u = this.users.get(id);
    return u ? this.clone(u) : null;
  }

  async ensureUser(id: number, chatId: number, firstName: string) {
    const u = this.users.get(id) ?? { id, chatId, firstName, timezone: null, defaultGapDays: 2, creds: null, pending: null };
    u.chatId = chatId;
    u.firstName = firstName;
    this.users.set(id, u);
    return this.clone(u);
  }

  async updateUser(id: number, patch: UserPatch) {
    const u = this.users.get(id);
    if (!u) return;
    Object.assign(u, this.clone(patch));
  }

  async listConnectedUserIds() {
    return [...this.users.values()].filter((u) => u.creds).map((u) => u.id);
  }

  async createItem(n: NewItem) {
    const item: Item = {
      id: ++this.seq,
      userId: n.userId,
      kind: n.kind,
      status: n.status,
      payload: this.clone(n.payload),
      gapDays: n.gapDays,
      dueAt: n.dueAt ?? null,
      nextAt: n.nextAt ?? null,
      nudgeCount: 0,
      lastNudgedAt: null,
      createdAt: new Date(),
    };
    this.items.set(item.id, item);
    return this.clone(item);
  }

  async getItem(id: number, userId: number) {
    const i = this.items.get(id);
    return i && i.userId === userId ? this.clone(i) : null;
  }

  async updateItem(id: number, userId: number, patch: ItemPatch) {
    const i = this.items.get(id);
    if (!i || i.userId !== userId) return;
    Object.assign(i, this.clone(patch));
  }

  async listItems(userId: number, statuses: ItemStatus[], kind?: ItemKind) {
    return [...this.items.values()]
      .filter((i) => i.userId === userId && statuses.includes(i.status) && (!kind || i.kind === kind))
      .sort((a, b) => (a.nextAt ?? a.createdAt).getTime() - (b.nextAt ?? b.createdAt).getTime())
      .map((i) => this.clone(i));
  }

  async claimDue(now: Date, leaseMs: number, limit: number, userId?: number) {
    const due = [...this.items.values()]
      .filter((i) => i.status === "open" && i.nextAt && i.nextAt <= now && (!userId || i.userId === userId))
      .sort((a, b) => a.nextAt!.getTime() - b.nextAt!.getTime())
      .slice(0, limit);
    for (const i of due) i.nextAt = new Date(now.getTime() + leaseMs);
    return due.map((i) => this.clone(i));
  }

  async enqueueMemory(userId: number, text: string) {
    const id = ++this.outSeq;
    this.outbox.set(id, { id, userId, text, attempts: 0, nextTry: new Date(0) });
    return id;
  }

  async deleteOutbox(id: number) {
    this.outbox.delete(id);
  }

  async claimOutbox(now: Date, limit: number) {
    const due = [...this.outbox.values()].filter((o) => o.nextTry <= now).slice(0, limit);
    for (const o of due) {
      o.attempts += 1;
      o.nextTry = new Date(now.getTime() + 10 * 60_000);
    }
    return due.map(({ id, userId, text, attempts }) => ({ id, userId, text, attempts }));
  }

  async failOutbox(id: number, _error: string, nextTry: Date) {
    const o = this.outbox.get(id);
    if (o) o.nextTry = nextTry;
  }

  async markUpdateSeen(updateId: number) {
    if (this.seen.has(updateId)) return false;
    this.seen.set(updateId, new Date());
    return true;
  }

  async pruneSeenUpdates(before: Date) {
    for (const [k, v] of this.seen) if (v < before) this.seen.delete(k);
  }

  async addMediaPart(userId: number, groupId: string, messageId: number, now: Date) {
    const key = `${userId}:${groupId}:${messageId}`;
    if (!this.parts.has(key)) this.parts.set(key, { userId, groupId, messageId, part: null, updatedAt: now });
  }

  async finishMediaPart(userId: number, groupId: string, messageId: number, part: MediaPart, now: Date) {
    const p = this.parts.get(`${userId}:${groupId}:${messageId}`);
    if (p) Object.assign(p, { part: this.clone(part), updatedAt: now });
  }

  async claimMediaGroup(userId: number, groupId: string, quietSince: Date) {
    const group = [...this.parts.entries()].filter(([, p]) => p.userId === userId && p.groupId === groupId);
    if (!group.length || group.some(([, p]) => !p.part || p.updatedAt > quietSince)) return null;
    for (const [k] of group) this.parts.delete(k);
    return group.sort(([, a], [, b]) => a.messageId - b.messageId).map(([, p]) => p.part!);
  }

  async pruneMediaParts(before: Date) {
    for (const [k, p] of this.parts) if (p.updatedAt < before) this.parts.delete(k);
  }
}
