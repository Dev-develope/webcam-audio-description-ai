import { createClient } from "jsr:@supabase/supabase-js@2.45.6";

// 60db TTS over its WebSocket API. Mirrors the contract of the sibling `tts`
// function (GET ?text=... -> streamed audio, teed to Supabase Storage) so it is
// a drop-in alternative to the ElevenLabs/OpenAI providers. The frontend only
// needs to point its <audio> src at this function name to switch providers.
//
// Protocol (see https://docs.60db.ai/websocket-api/tts): every message is a
// single-key envelope `{ <type>: { ...fields } }`.
//   1. connect wss://api.60db.ai/ws/tts?apiKey=...
//   2. server -> { connection_established: {...} }
//   3. client -> { create_context: { context_id, voice_id, audio_config } }
//   4. client -> { send_text: { context_id, text } }
//   5. client -> { close_context: { context_id } }   // flushes remaining text
//   6. server -> { audio_chunk: { context_id, audioContent } }  // base64, repeated
//   7. server -> { context_closed: { context_id } }
//
// We request LINEAR16 (raw 16-bit signed little-endian mono PCM), which the docs
// note concatenates directly across chunks. <audio> cannot play raw PCM, so we
// buffer the chunks and wrap them in a WAV header before responding.

const SIXTYDB_API_KEY = Deno.env.get("SIXTYDB_API_KEY")!;
const SIXTYDB_VOICE_ID = Deno.env.get("SIXTYDB_VOICE_ID") ?? "";
const SIXTYDB_WS_URL = Deno.env.get("SIXTYDB_WS_URL") ??
  "wss://api.60db.ai/ws/tts";
const SAMPLE_RATE_HERTZ = 24000;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type StorageFileApi = ReturnType<typeof supabase.storage.from>;
type StorageUploadPromise = ReturnType<StorageFileApi["upload"]>;

class MyBackgroundTaskEvent extends Event {
  readonly taskPromise: StorageUploadPromise;

  constructor(taskPromise: StorageUploadPromise) {
    super("myBackgroundTask");
    this.taskPromise = taskPromise;
  }
}

globalThis.addEventListener(
  "myBackgroundTask",
  async (event) => {
    const { data, error } = await (event as MyBackgroundTaskEvent).taskPromise;
    console.log({ data, error });
  },
);

// Shape of the single-key envelopes the 60db server sends back over the socket.
interface ServerMessage {
  connection_established?: unknown;
  audio_chunk?: { audioContent?: string };
  context_closed?: unknown;
  error?: { message?: string };
}

// Decode a base64 string to raw bytes (atob yields a binary string).
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Wrap mono 16-bit PCM samples in a minimal 44-byte WAV header so the result is
// playable by a browser <audio> element.
function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;

  const buffer = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true); // file size - 8
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, pcm.length, true);

  const wav = new Uint8Array(buffer);
  wav.set(pcm, 44);
  return wav;
}

// Open a WebSocket to 60db, synthesize `text`, and resolve once all audio
// chunks have been received and the context is closed.
function synthesize(text: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const contextId = `ctx_${Date.now()}`;
    const url =
      `${SIXTYDB_WS_URL}?apiKey=${encodeURIComponent(SIXTYDB_API_KEY)}`;
    const ws = new WebSocket(url);

    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (_) {
        // ignore
      }
      if (err) {
        reject(err);
        return;
      }
      const pcm = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(pcm);
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        );
      } catch (_) {
        return; // ignore non-JSON frames
      }

      const audioContent = msg.audio_chunk?.audioContent;
      if (msg.connection_established) {
        ws.send(JSON.stringify({
          create_context: {
            context_id: contextId,
            voice_id: SIXTYDB_VOICE_ID,
            audio_config: {
              audio_encoding: "LINEAR16",
              sample_rate_hertz: SAMPLE_RATE_HERTZ,
            },
          },
        }));
        ws.send(JSON.stringify({
          send_text: { context_id: contextId, text },
        }));
        // close_context flushes any remaining buffered text before closing.
        ws.send(JSON.stringify({
          close_context: { context_id: contextId },
        }));
      } else if (audioContent) {
        const bytes = decodeBase64(audioContent);
        chunks.push(bytes);
        totalLength += bytes.length;
      } else if (msg.context_closed) {
        finish();
      } else if (msg.error) {
        finish(new Error(msg.error.message ?? "60db TTS error"));
      }
    };

    ws.onerror = () => finish(new Error("60db WebSocket error"));
    ws.onclose = () => finish(); // resolve with whatever we got if closed early
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const params = new URLSearchParams(url.search);
  const text = params.get("text");

  if (!text) {
    return new Response(
      JSON.stringify({ error: "Text parameter is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const pcm = await synthesize(text);
    const wav = pcmToWav(pcm, SAMPLE_RATE_HERTZ);

    // Upload a copy to Supabase Storage as a background task, mirroring the
    // sibling `tts` function.
    const storageUploadPromise = supabase.storage
      .from("videos")
      .upload(`audio-stream_${Date.now()}.wav`, wav, {
        contentType: "audio/wav",
      });
    const event = new MyBackgroundTaskEvent(storageUploadPromise);
    globalThis.dispatchEvent(event);

    return new Response(wav, {
      headers: {
        "Content-Type": "audio/wav",
      },
    });
  } catch (error) {
    console.log("error", { error });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
