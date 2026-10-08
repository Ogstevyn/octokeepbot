import type { Action, Button } from "../types.js";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Telegram rejects messages over 4096 characters.
export const clip = (s: string, max = 3900) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const effortLabel = (a: Action) => `(${a.effort})`;

export const TZ_BUTTONS: Button[][] = [
  [
    { text: "Lagos", data: "tz:Africa/Lagos" },
    { text: "London", data: "tz:Europe/London" },
    { text: "Nairobi", data: "tz:Africa/Nairobi" },
  ],
  [
    { text: "New York", data: "tz:America/New_York" },
    { text: "Los Angeles", data: "tz:America/Los_Angeles" },
    { text: "India", data: "tz:Asia/Kolkata" },
  ],
];

export const intentButtons = (id: number): Button[][] => [
  [
    { text: "Yes", data: `i:${id}:y` },
    { text: "Maybe later", data: `i:${id}:m` },
    { text: "No", data: `i:${id}:n` },
  ],
];

export const gapButtons = (id: number): Button[][] => [
  [
    { text: "1 day", data: `g:${id}:1` },
    { text: "2 days", data: `g:${id}:2` },
    { text: "3 days", data: `g:${id}:3` },
    { text: "1 week", data: `g:${id}:7` },
  ],
  [{ text: "Other time", data: `g:${id}:o` }],
];

export const defaultGapButtons: Button[][] = [
  [
    { text: "1 day", data: "dg:1" },
    { text: "2 days", data: "dg:2" },
    { text: "3 days", data: "dg:3" },
    { text: "1 week", data: "dg:7" },
  ],
];

export const nudgeButtons = (id: number): Button[][] => [
  [
    { text: "Done", data: `n:${id}:done` },
    { text: "Partly", data: `n:${id}:part` },
  ],
  [
    { text: "Snooze 3 days", data: `n:${id}:s3` },
    { text: "Drop it", data: `n:${id}:drop` },
  ],
];

export const taskButtons = (id: number): Button[][] => [
  [
    { text: "Done", data: `t:${id}:done` },
    { text: "Snooze 1h", data: `t:${id}:h1` },
  ],
  [
    { text: "Tomorrow", data: `t:${id}:tm` },
    { text: "Reschedule", data: `t:${id}:rs` },
  ],
];

export const timeButtons: Button[][] = [
  [
    { text: "Morning 9:00", data: "tt:09:00" },
    { text: "Afternoon 14:00", data: "tt:14:00" },
    { text: "Evening 19:00", data: "tt:19:00" },
  ],
];

export const HELP = `<b>How to use OctoKeep</b>

Send a link to a video, article or post. I summarise it, ask what you plan to do, and check back when you choose: a few days, a week, or any time you type, like 30 min or 6pm.

For Instagram, send a screenshot of the post (tap "more" first so the whole caption shows) or a screen recording of the Reel. Several screenshots sent together become one summary.

You can also send voice messages instead of typing.

Tell me something you want to do and when, like "build an app on Thursday, remind me". I ask a few short questions and send you a plan at that time.

Ask about your memory: "what did I save about Rust?" or "what have I been ignoring?"

<b>Commands</b>
/list  your saved posts and open items
/tasks  upcoming tasks
/ignored  things you have not acted on
/memory  how many memories are stored
/gap  change your default check-back time
/done 12  mark item 12 done
/buddy  add a friend who hears if you miss a reminder
/path rust  turn your saves on a topic into a learning plan
/topics  your saves grouped by topic
/timezone  change your timezone
/connect  link your Walrus Memory account
/disconnect  remove the saved key
/cancel  stop the current question`;

export const CONNECT_STEPS = `<b>Connect your Walrus Memory</b>

1. Open memory.walrus.xyz and sign in.
2. Under Delegate keys, select Add key and name it OctoKeep.
3. From SDK credentials, copy your Account ID.

Send me the Account ID now. It starts with 0x.`;
