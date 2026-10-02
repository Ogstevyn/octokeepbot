import { neon } from "@neondatabase/serverless";
import { decryptJson, encryptJson, encrypt, decrypt } from "../crypto.js";
import type { Item, ItemKind, ItemStatus, MemwalCreds, Pending, User } from "../types.js";
import type { ItemPatch, NewItem, OutboxEntry, Repo, UserPatch } from "./repo.js";

type Row = Record<string, unknown>;
type Sql = ReturnType<typeof neon>;

const date = (v: unknown): Date | null => (v == null ? null : new Date(v as string));

export class NeonRepo implements Repo {
  private sql: Sql;

  constructor(databaseUrl: string, private keyHex: string) {
    this.sql = neon(databaseUrl);
  }

  private q(text: string, params: unknown[] = []): Promise<Row[]> {
    return this.sql.query(text, params) as Promise<Row[]>;
  }

  private toUser(r: Row): User {
    return {
      id: Number(r.id),
      chatId: Number(r.chat_id),
      firstName: String(r.first_name ?? ""),
      timezone: (r.timezone as string | null) ?? null,
      defaultGapDays: Number(r.default_gap_days),
      creds: r.creds_enc ? decryptJson<MemwalCreds>(r.creds_enc as string, this.keyHex) : null,
      pending: r.pending_enc ? decryptJson<Pending>(r.pending_enc as string, this.keyHex) : null,
    };
  }

  private toItem(r: Row): Item {
    return {
      id: Number(r.id),
      userId: Number(r.user_id),
      kind: r.kind as ItemKind,
      status: r.status as ItemStatus,
      payload: decryptJson<Item["payload"]>(r.payload_enc as string, this.keyHex),
      gapDays: Number(r.gap_days),
      dueAt: date(r.due_at),
      nextAt: date(r.next_at),
      nudgeCount: Number(r.nudge_count),
      lastNudgedAt: date(r.last_nudged_at),
      createdAt: date(r.created_at)!,
    };
  }

  async getUser(id: number) {
    const rows = await this.q("SELECT * FROM users WHERE id = $1", [id]);
    return rows[0] ? this.toUser(rows[0]) : null;
  }

  async ensureUser(id: number, chatId: number, firstName: string) {
    const rows = await this.q(
      `INSERT INTO users (id, chat_id, first_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET chat_id = EXCLUDED.chat_id, first_name = EXCLUDED.first_name, updated_at = now()
       RETURNING *`,
      [id, chatId, firstName],
    );
    return this.toUser(rows[0]!);
  }

  async updateUser(id: number, patch: UserPatch) {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.chatId !== undefined) add("chat_id", patch.chatId);
    if (patch.firstName !== undefined) add("first_name", patch.firstName);
    if (patch.timezone !== undefined) add("timezone", patch.timezone);
    if (patch.defaultGapDays !== undefined) add("default_gap_days", patch.defaultGapDays);
    if (patch.creds !== undefined) add("creds_enc", patch.creds ? encryptJson(patch.creds, this.keyHex) : null);
    if (patch.pending !== undefined) add("pending_enc", patch.pending ? encryptJson(patch.pending, this.keyHex) : null);
    if (!sets.length) return;
    params.push(id);
    await this.q(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
  }

  async listConnectedUserIds() {
    const rows = await this.q("SELECT id FROM users WHERE creds_enc IS NOT NULL");
    return rows.map((r) => Number(r.id));
  }

  async createItem(item: NewItem) {
    const rows = await this.q(
      `INSERT INTO items (user_id, kind, status, payload_enc, gap_days, due_at, next_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [item.userId, item.kind, item.status, encryptJson(item.payload, this.keyHex), item.gapDays, item.dueAt ?? null, item.nextAt ?? null],
    );
    return this.toItem(rows[0]!);
  }

  async getItem(id: number, userId: number) {
    const rows = await this.q("SELECT * FROM items WHERE id = $1 AND user_id = $2", [id, userId]);
    return rows[0] ? this.toItem(rows[0]) : null;
  }

  async updateItem(id: number, userId: number, patch: ItemPatch) {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.payload !== undefined) add("payload_enc", encryptJson(patch.payload, this.keyHex));
    if (patch.gapDays !== undefined) add("gap_days", patch.gapDays);
    if (patch.dueAt !== undefined) add("due_at", patch.dueAt);
    if (patch.nextAt !== undefined) add("next_at", patch.nextAt);
    if (patch.nudgeCount !== undefined) add("nudge_count", patch.nudgeCount);
    if (patch.lastNudgedAt !== undefined) add("last_nudged_at", patch.lastNudgedAt);
    if (!sets.length) return;
    params.push(id, userId);
    await this.q(
      `UPDATE items SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length - 1} AND user_id = $${params.length}`,
      params,
    );
  }

  async listItems(userId: number, statuses: ItemStatus[], kind?: ItemKind) {
    const rows = kind
      ? await this.q("SELECT * FROM items WHERE user_id = $1 AND status = ANY($2) AND kind = $3 ORDER BY COALESCE(next_at, created_at)", [userId, statuses, kind])
      : await this.q("SELECT * FROM items WHERE user_id = $1 AND status = ANY($2) ORDER BY COALESCE(next_at, created_at)", [userId, statuses]);
    return rows.map((r) => this.toItem(r));
  }

  async claimDue(now: Date, leaseMs: number, limit: number, userId?: number) {
    const lease = new Date(now.getTime() + leaseMs);
    // A single UPDATE ... RETURNING is atomic, so two ticks cannot claim the
    // same row: the second one no longer sees next_at <= now.
    const rows = await this.q(
      `UPDATE items SET next_at = $2, updated_at = now()
       WHERE id IN (
         SELECT id FROM items
         WHERE status = 'open' AND next_at <= $1 ${userId ? "AND user_id = $4" : ""}
         ORDER BY next_at LIMIT $3
       ) AND status = 'open' AND next_at <= $1
       RETURNING *`,
      userId ? [now, lease, limit, userId] : [now, lease, limit],
    );
    return rows.map((r) => this.toItem(r));
  }

  async enqueueMemory(userId: number, text: string) {
    const rows = await this.q("INSERT INTO memory_outbox (user_id, text_enc) VALUES ($1, $2) RETURNING id", [userId, encrypt(text, this.keyHex)]);
    return Number(rows[0]!.id);
  }

  async deleteOutbox(id: number) {
    await this.q("DELETE FROM memory_outbox WHERE id = $1", [id]);
  }

  async claimOutbox(now: Date, limit: number): Promise<OutboxEntry[]> {
    const rows = await this.q(
      `UPDATE memory_outbox SET next_try = $1::timestamptz + interval '10 minutes', attempts = attempts + 1
       WHERE id IN (SELECT id FROM memory_outbox WHERE next_try <= $1 ORDER BY id LIMIT $2)
       RETURNING *`,
      [now, limit],
    );
    return rows.map((r) => ({ id: Number(r.id), userId: Number(r.user_id), text: decrypt(r.text_enc as string, this.keyHex), attempts: Number(r.attempts) }));
  }

  async failOutbox(id: number, error: string, nextTry: Date) {
    await this.q("UPDATE memory_outbox SET last_error = $2, next_try = $3 WHERE id = $1", [id, error.slice(0, 500), nextTry]);
  }

  async markUpdateSeen(updateId: number) {
    const rows = await this.q("INSERT INTO seen_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id", [updateId]);
    return rows.length > 0;
  }

  async pruneSeenUpdates(before: Date) {
    await this.q("DELETE FROM seen_updates WHERE seen_at < $1", [before]);
  }
}

export async function migrate(databaseUrl: string, schemaSql: string) {
  const sql = neon(databaseUrl);
  const statements = schemaSql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of statements) await sql.query(s);
  return statements.length;
}
