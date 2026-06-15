# Webcam Audio Description Generator

Generate audio descriptions for your videos using [Google Gemini]() and [ElevenLabs]().

## Setup

- `cp supabase/functions/.env. example supabase/functions/.env`
- Set your [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key) in `supabase/functions/.env`
- Set your [ElevenLabs API key](elevenlabs.io/?from=partnersmith6824) in `supabase/functions/.env`

## Run locally

```bash
supabase start
supabase functions serve --no-verify-jwt
# In another terminal
python3 -m http.server
```

Open http://localhost:8000/

## TTS providers

Each TTS provider is a Supabase Edge Function sharing the same contract:
`GET ?text=...` returns streamed audio. The frontend (`index.html`) picks one by
the function name in the `<audio>` src.

- `tts` — ElevenLabs (default; teed to Storage)
- `tts-openai` — OpenAI
- `tts-60db` — [60db](https://docs.60db.ai/) over its WebSocket API. Set
  `SIXTYDB_API_KEY` and `SIXTYDB_VOICE_ID` in `supabase/functions/.env`. To use
  it, change the function name in `index.html` from `tts` to `tts-60db`.
