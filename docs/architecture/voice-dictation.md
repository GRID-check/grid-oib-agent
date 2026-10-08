# Voice dictation

A microphone button in the chat composer. The member presses it, speaks for up
to 45 seconds, presses again (or waits), and clean text appears where the caret
was. The aim is the feel of a dictation tool: speak naturally, get text you
would have typed.

## What is true when it works

- The button sits in the composer's control row, before the paperclip.
- While recording, the button shows a live waveform of the microphone level
  and the elapsed seconds (`AudioWave`, `frontends/ui/src/components/ui/audio-wave.tsx`).
- Recording stops by itself at 45 seconds (`MAX_DICTATION_SECONDS`).
- A browser with no microphone API, no supported container, a page that is not
  `https`, or a microphone permission the member denied gets the button
  **disabled**, with the reason on hover and on keyboard focus.
- Chromium and Firefox record WebM/Opus (Firefox also Ogg); Safari records
  MP4/AAC, sent as `m4a`. A browser offering none of them gets the disabled
  button.
- German and English mixed in one sentence come back as spoken. **No language
  is ever sent to the provider.** The UI language picks only a wording hint.
- The text is inserted at the caret, or appended when the composer never had
  one. A selection is not replaced; the transcript goes after it. Existing text
  is never overwritten.
- Fillers (`äh`, `ähm`, `öhm`, `uh`, `uhm`, `erm`, `hmm`, `umm`) are removed.
  `um` is removed only where the German preposition cannot stand: opening a
  sentence before a comma ("Um, I think …") or as an aside between commas.
- Silence inserts nothing.
- Every failure is the composer's usual inline error. The message is never
  cleared, and the chat is never affected.
- Nobody is billed for dictation and no budget ever blocks it. The real cost,
  with the seconds of audio, is on the ledger, and Platform → Overview names
  the share of cost that was voice input.
- The transcript is not screened for „Sensible Daten" when it comes back: it
  lands in the composer as is, and is screened at send like typed text (the
  composer's hold, then the chat socket's mask). The audio itself reaches the
  transcription model unscreened (zero data retention on the platform's key,
  the provider's own policy for an office on its own key), so dictation is one
  of the doors the
  [ADR-0085 chat amendment](../adr/0085-uploads-are-screened-locally-and-matches-wait-in-quarantine.md#amendment-2026-10-02-chat-messages-are-screened-too)
  lists under "Neutral", outside chat screening.

## How a recording travels

```
Browser (features/dictation)          BFF (lib/dictation)                 Python (aiq_api/routes/dictation.py)        OpenRouter
───────────────────────────           ───────────────────                 ────────────────────────────────────        ──────────
MediaRecorder, ≤45 s, 64 kbit/s
level meter: silent? → stop here
POST /api/dictation (multipart) ──▶  session, DICTATION_LIMIT,
                                      size ≤4 MB, format check
                                      POST /v1/dictation (JSON, ──────▶   internal token; org credential (BYOK
                                      internal token, org, user)          or platform, pinned ZDR); provider
                                                                          limiter slot; primary, then
                                                                          fallback only on failure ──────────▶  /audio/transcriptions
                                                                          clean_transcript (fillers, silence)
                                                                          ledger: activity=dictation, audio_seconds
                                      ◀── { text } or error code ◀───────
insertTranscript at caret ◀──────────
```

| Concern | Owning code |
|---|---|
| The button and its states | `frontends/ui/src/features/dictation/components/DictationButton.tsx` (`DictationButton`, presentational `DictationControl`) |
| Recording, the 45 s stop, the silence gate | `frontends/ui/src/features/dictation/hooks/use-dictation.ts` |
| Which browsers can dictate, and why not | `frontends/ui/src/features/dictation/lib/recording-support.ts` |
| Where the text goes | `frontends/ui/src/features/dictation/lib/insert-transcript.ts` |
| Bounds shared by both sides | `frontends/ui/src/lib/dictation/contract.ts` |
| The BFF route and service | `frontends/ui/src/app/api/dictation/route.ts`, `frontends/ui/src/lib/dictation/service.ts` |
| The provider call, models, fallback, ledger row | `frontends/aiq_api/src/aiq_api/routes/dictation.py` |
| Filler removal and silence phrases | `frontends/aiq_api/src/aiq_api/routes/_dictation_text.py` |
| The composer's side | `frontends/ui/src/features/layout/components/InputArea.tsx` (`handleTranscript`) |
| Preview | `/dev/dictation` |

The facade is `frontends/ui/src/features/dictation/index.ts`; the composer
imports nothing else from the module. There is no new deployable and no feature
flag.

## The decision: a transcription endpoint, not a chat model

Two ways were on the table:

- **A. A dedicated transcription endpoint** (`/audio/transcriptions`). It is
  documented, takes the browser's own containers, returns the duration and the
  cost, and does not take instructions from the audio.
- **B. A chat model given the audio**, which could transcribe and clean up in
  one call. Its browser-format support, duration reporting and mixed-language
  quality are unverified, and it may paraphrase or follow an instruction spoken
  into the microphone.

**A is built.** The part of B that A lacks, removing fillers, does not need a
model: `clean_transcript` removes them deterministically after any model, so the
requirement no longer depends on whether a provider honours a prompt. B is worth
revisiting only if a live test shows A's output needs more than filler removal.

## Models and fallback

| Variable | Default | |
|---|---|---|
| `GRID_DICTATION_MODEL` | `elevenlabs/scribe-v2` | Primary model |
| `GRID_DICTATION_FALLBACK_MODEL` | `openai/whisper-large-v3-turbo` | Tried only when the primary failed; empty switches it off |

These are environment variables, like `SUMMARY_LLM_MODEL`, because dictation
is not an agent group: Platform → Models validates a group's model against chat
requirements, and a transcription model meets none of them. Making it
admin-selectable needs an audio requirement in `validateModelForGroup` first.

On the platform's key the request is pinned to zero data retention, as for every
model the platform fixes (`openrouter.PLATFORM_FIXED`), so **a dictation model
must have a ZDR endpoint**: check `GET https://openrouter.ai/api/v1/endpoints/zdr`
before changing either variable. On OpenRouter the body is JSON with
`input_audio`.

An organization on its own OpenAI-compatible key follows its own policy and is
sent that provider's own model names (`OWN_KEY_MODELS`: `gpt-4o-transcribe`,
then `whisper-1`) in the provider's multipart contract, because the defaults
above are OpenRouter ids. A custom provider without those models, and Azure
OpenAI's deployment paths, fail as `transcription_failed`.

### Why these two: the live test

Run on 2026-10-08 against OpenRouter with the platform's ZDR pin, through the
route's own `_attempt` and `clean_transcript`. **The ten clips were synthetic**:
ElevenLabs multilingual TTS (one male voice) reading mixed German and English
sentences with written-in fillers, transcoded to WebM/Opus and MP4/AAC at
64 kbit/s the way the browsers record. Synthetic speech is cleaner than a
person in an office, so this ranks the models; it does not prove real-world
quality.

| Model | ZDR endpoint | Succeeded (pinned) | Mixed DE/EN | Cost, 10 clips | Latency |
|---|---|---|---|---|---|
| `elevenlabs/scribe-v2` | ElevenLabs | 10/10 WebM, 10/10 M4A | Kept every sentence as spoken | $0.0014 | ~1.2 s |
| `openai/whisper-large-v3-turbo` | DeepInfra, Groq | 10/10, 10/10 | Kept, more misspelt German terms ("Brandebschnitt", "Baupalizai") | $0.0003 | ~3.5 s |
| `openai/whisper-large-v3` | DeepInfra, Together, Groq | 5/10 (404s) | Kept | $0.0015 (5 clips) | ~1.1 s |
| `deepgram/nova-3` | Deepgram | 10/10 | **Dropped the German half** of mixed sentences, or returned nothing | $0.0033 | ~0.5 s |
| `mistralai/voxtral-mini-transcribe` | Mistral | 0/10 (404) | — | — | — |
| `openai/gpt-4o-transcribe` | **none** | 0/10 (404 under the pin) | — | — | — |

What it settled:

- **Fillers:** Scribe and Whisper Turbo both write `äh`, `ähm`, `um` and `uh`
  into the transcript. `clean_transcript` removed every one in all twenty
  outputs. The requirement rests on the cleanup, not on the model.
- **Pricing:** both report `usage.cost` and `usage.seconds`. Scribe is about
  $0.00003 per second of audio, so a 45-second dictation costs about $0.0014.
- **Formats:** WebM/Opus and MP4/AAC (sent as `m4a`) both work on both models.
- **Silence:** pure silence returns nothing; Scribe writes `[pause]` over room
  noise, which the cleanup now strips with any other short bracketed
  audio-event tag.

## Cost: recorded, never billed

The backend books each successful transcription as a ledger row with
`activity = 'dictation'`, `agent_group = 'dictation'`, the provider's reported
`cost_usd` and `audio_seconds` (the provider's duration, else the browser's
measurement). The BFF then:

- prices it at nothing (`UNBILLED_USAGE_ACTIVITIES` in `recordUsageEvents`), and
  migration 0107's CHECK refuses a dictation row with a price, so a later writer
  cannot bill it by mistake;
- keeps it out of `llm_usage_rollups` (`buildRollupIncrements`), which is all a
  budget reads, so dictation can never block anyone.

What bounds the spend instead is the per-member `DICTATION_LIMIT` (120 an hour,
6 a minute) and the provider limiter. An organization on its own key pays its
provider for dictation like for every other call; Piloti bills it nothing.

Tenant-facing usage views read the ledger, so a dictation row shows there with
0 credits. Its tokens are counted in those views and in no budget.

## Still unverified

Each item stays marked here until it is tested.

- **Real voices.** The live test used synthetic speech. Mixed German and
  English quality on about ten real clips (different speakers, an office
  microphone, an Austrian accent, a switch mid-sentence) is still open. The
  failure to look for is a model translating or dropping the other language,
  which `deepgram/nova-3` did even on clean synthetic audio.
- **Whether a model drops fillers on its own** with natural hesitation (the
  synthetic fillers were read out as words). It no longer matters for the
  requirement, since the cleanup removes them either way.
- **Whether OpenRouter forwards the wording hint.** It is sent as
  `provider.options.<openai|groq>.prompt`. OpenRouter documents that path for
  Groq only, and Scribe has no slot for it. No observable effect was tested.
- **The silence floor** (`SILENCE_RMS = 0.01`) against real microphones,
  including a quiet one. Set too high, it drops quiet speech without a word.
- **Safari end to end.** The MP4/AAC container was tested against the
  provider; recording in a real Safari was not.
- **An organization's own OpenAI key** (`OWN_KEY_MODELS`, multipart) was not
  tested against `api.openai.com`.

## What fails how

| Situation | Code | What the member sees |
|---|---|---|
| Rate limit reached | 429 | "Too many recordings in a short time …" |
| Recording over 4 MB | 413 | "The recording is too large to transcribe." |
| No credential configured | 503 (`transcription_not_configured`) | "Voice input is not available right now." |
| Both models failed, timeout, backend down | 502 (`transcription_failed`) | "The recording could not be transcribed. Your message is unchanged." |
| Silence, or a hallucinated subtitle credit | 200, empty text | Nothing |
