// Reads screenshots with a vision model and transcribes video and voice with a
// speech-to-text model. Both use the OpenAI-compatible endpoints that Groq,
// OpenAI and others serve, with the same base URL and key as the main model.

export interface Media {
  // Null when no vision model is configured.
  readImage: ((image: Uint8Array, mime: string) => Promise<string>) | null;
  // Null when no transcription model is configured.
  transcribe: ((file: Uint8Array, filename: string, mime: string) => Promise<string>) | null;
}

export class MediaError extends Error {}

export const IMAGE_PROMPT = `This is a screenshot someone saved, usually of a social media post.
Write out the readable content:
- the author or handle, if visible
- the full caption or post text, word for word
- any text written on the image itself
- visible comments, each starting with "Comment:"
Skip app interface text: buttons, like and view counts, navigation, the status bar, ads.
End with one line starting "Image:" that says what the picture shows.
If there is no readable content, reply with the "Image:" line only. Plain text, no commentary.`;

// Reasoning models can wrap their thinking in tags; keep only the answer.
export const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export function createMedia(opts: { baseURL: string; apiKey: string; visionModel: string | null; transcribeModel: string | null }): Media {
  const base = opts.baseURL.replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${opts.apiKey}` };

  const fail = async (what: string, res: Response) => {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    return new MediaError(`${what} failed with HTTP ${res.status}: ${body}`);
  };

  const readImage = opts.visionModel
    ? async (image: Uint8Array, mime: string) => {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({
            model: opts.visionModel,
            temperature: 0,
            max_tokens: 2000,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: IMAGE_PROMPT },
                  { type: "image_url", image_url: { url: `data:${mime};base64,${toBase64(image)}` } },
                ],
              },
            ],
          }),
        });
        if (!res.ok) throw await fail("reading the image", res);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return stripThinking(data.choices?.[0]?.message?.content ?? "");
      }
    : null;

  const transcribe = opts.transcribeModel
    ? async (file: Uint8Array, filename: string, mime: string) => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(file)], { type: mime }), filename);
        form.append("model", opts.transcribeModel!);
        form.append("response_format", "json");
        form.append("temperature", "0");
        const res = await fetch(`${base}/audio/transcriptions`, {
          method: "POST",
          headers: auth,
          body: form,
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw await fail("transcription", res);
        const data = (await res.json()) as { text?: string };
        return (data.text ?? "").trim();
      }
    : null;

  return { readImage, transcribe };
}

// Whisper invents short phrases on music or silence ("Thank you.", "you").
// Treat a transcript as speech only when it has some substance.
export function hasSpeech(transcript: string): boolean {
  const words = transcript.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return words.length >= 8;
}

// Vision replies that are only the "Image:" line mean there was no text.
export function hasText(extracted: string): boolean {
  const body = extracted
    .split("\n")
    .filter((l) => !/^\s*image:/i.test(l))
    .join(" ")
    .trim();
  return body.length >= 20;
}
