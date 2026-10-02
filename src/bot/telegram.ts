import { Api, Bot, GrammyError, type Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { Button } from "../types.js";
import { BlockedError, handleCallback, handleMedia, handleMessage, type Deps, type IncomingMedia, type Out } from "./core.js";

const toKeyboard = (rows?: Button[][]) =>
  rows?.length
    ? {
        inline_keyboard: rows.map((row) =>
          row.map((b): InlineKeyboardButton => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? "noop" })),
        ),
      }
    : undefined;

// 403 means the user blocked the bot or deleted the chat.
const isBlocked = (e: unknown) => e instanceof GrammyError && (e.error_code === 403 || /chat not found|user is deactivated/i.test(e.description));

export function telegramOut(api: Api, log: Deps["log"]): Out {
  return {
    async send(chatId, html, buttons) {
      try {
        const m = await api.sendMessage(chatId, html, { parse_mode: "HTML", reply_markup: toKeyboard(buttons), link_preview_options: { is_disabled: true } });
        return m.message_id;
      } catch (e) {
        if (isBlocked(e)) throw new BlockedError(String(e));
        // A formatting mistake must never lose the message: retry as plain text.
        if (e instanceof GrammyError && e.error_code === 400 && /parse entities|can't parse/i.test(e.description)) {
          const plain = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
          const m = await api.sendMessage(chatId, plain, { reply_markup: toKeyboard(buttons) });
          return m.message_id;
        }
        throw e;
      }
    },
    async removeButtons(chatId, messageId) {
      try {
        await api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } });
      } catch (e) {
        // "message is not modified" or too old: nothing to do.
        if (!(e instanceof GrammyError)) log("removeButtons failed", String(e));
      }
    },
    async deleteMessage(chatId, messageId) {
      try {
        await api.deleteMessage(chatId, messageId);
      } catch (e) {
        log("deleteMessage failed", String(e));
      }
    },
    async typing(chatId) {
      try {
        await api.sendChatAction(chatId, "typing");
      } catch {
        // Cosmetic only.
      }
    },
  };
}

// Downloads a file the user sent. The URL contains the bot token, so errors
// never include it.
const downloader = (api: Api, token: string, fileId: string) => async () => {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file path");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`file download failed with HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

// Maps a Telegram message to the media OctoKeep understands, or null.
function mediaOf(ctx: Context, token: string): IncomingMedia | null {
  const msg = ctx.message;
  if (!msg || !ctx.from || ctx.chat?.type !== "private") return null;
  const base = {
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    messageId: msg.message_id,
    firstName: ctx.from.first_name ?? "",
    caption: msg.caption ?? "",
    groupId: msg.media_group_id,
  };
  const make = (kind: IncomingMedia["kind"], fileId: string, mime: string, fileSize?: number): IncomingMedia => ({
    ...base,
    kind,
    mime,
    fileSize,
    download: downloader(ctx.api, token, fileId),
  });

  if (msg.photo?.length) {
    const p = msg.photo.at(-1)!; // largest size
    return make("image", p.file_id, "image/jpeg", p.file_size);
  }
  if (msg.voice) return make("voice", msg.voice.file_id, msg.voice.mime_type ?? "audio/ogg", msg.voice.file_size);
  if (msg.video_note) return make("voice", msg.video_note.file_id, "video/mp4", msg.video_note.file_size);
  if (msg.video) return make("recording", msg.video.file_id, msg.video.mime_type ?? "video/mp4", msg.video.file_size);
  if (msg.audio) return make("recording", msg.audio.file_id, msg.audio.mime_type ?? "audio/mpeg", msg.audio.file_size);
  const doc = msg.document;
  if (doc?.mime_type) {
    if (/^image\/(jpeg|png|webp)$/.test(doc.mime_type)) return make("image", doc.file_id, doc.mime_type, doc.file_size);
    if (/^(video|audio)\//.test(doc.mime_type)) return make("recording", doc.file_id, doc.mime_type, doc.file_size);
  }
  return null;
}

export function createBot(token: string, deps: (api: Api) => Deps): Bot {
  const bot = new Bot(token);
  const d = deps(bot.api);

  // Screenshots, screen recordings, and voice messages.
  bot.on(["message:photo", "message:video", "message:video_note", "message:voice", "message:audio", "message:document"], async (ctx, next) => {
    const media = mediaOf(ctx, token);
    if (!media) return next();
    await handleMedia(d, media);
  });

  bot.on(["message:text", "message:caption"], async (ctx) => {
    // OctoKeep keeps personal memory, so it only works in private chats.
    if (ctx.chat.type !== "private") return;
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    await handleMessage(d, {
      userId: ctx.from.id,
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      firstName: ctx.from.first_name ?? "",
      text,
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const msg = ctx.callbackQuery.message;
    if (!msg || msg.chat.type !== "private") return;
    await handleCallback(d, {
      userId: ctx.from.id,
      chatId: msg.chat.id,
      messageId: msg.message_id,
      firstName: ctx.from.first_name ?? "",
      data: ctx.callbackQuery.data,
    });
  });

  bot.catch(async (err) => {
    d.log("update failed", String(err.error instanceof Error ? (err.error.stack ?? err.error.message) : err.error));
    const chatId = err.ctx.chat?.id;
    if (chatId && err.ctx.chat?.type === "private") {
      await err.ctx.api.sendMessage(chatId, "Something went wrong on my side. Try again in a minute.").catch(() => undefined);
    }
  });

  return bot;
}

export const COMMANDS = [
  { command: "start", description: "Set up OctoKeep" },
  { command: "list", description: "Saved posts and open items" },
  { command: "tasks", description: "Upcoming tasks" },
  { command: "ignored", description: "Things you have not acted on" },
  { command: "gap", description: "Change the default check-back time" },
  { command: "done", description: "Mark an item done, e.g. /done 12" },
  { command: "timezone", description: "Change your timezone" },
  { command: "connect", description: "Link your Walrus Memory account" },
  { command: "disconnect", description: "Remove the saved key" },
  { command: "help", description: "How to use OctoKeep" },
  { command: "cancel", description: "Stop the current question" },
];
