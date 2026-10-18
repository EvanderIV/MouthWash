# MouthWash

Listens to **your own** microphone while you're talking in a voice call, and plays a sound you
choose the moment you say a word you're trying to stop saying — a filler word, a curse, a tic.
It's a habit-training nudge: the reaction lands within a fraction of a second, so you notice the
habit in the act rather than afterwards.

It is not a moderation, transcription or recording tool. It never listens to anyone else, never
changes what the call hears, and nothing it hears or decides ever leaves your computer.

## Privacy

- **On-device only.** No audio, features, transcripts, hypotheses or detection events are sent
  anywhere, ever. The only network access in the whole plugin is the one-time model download
  you explicitly start, and that download is hash-verified.
- **Nothing is recorded.** Audio moves through in 30 ms frames. Nothing is written to disk, and
  there is no record or replay path. While you're not transmitting, at most ~300 ms of audio
  sits in a ring buffer that is overwritten continuously. Under push-to-talk, there's no buffer.
- **No transcripts.** Recognizer output is matched against your word list and discarded in the
  same tick. Only counts persist: each word's lifetime hit count, in your local settings file.
- **The mic is closed when it should be.** It opens only while you're in a call, unmuted, with
  listening switched on (each condition can be relaxed under Advanced). All tracks are stopped
  and the audio context closed the moment that stops being true, so your OS mic indicator tells
  the truth.

## Getting started

1. Enable the plugin, then open its settings.
2. If your client has no on-device speech recognition (most don't yet), you'll see a one-time
   download prompt: the Vosk speech model (41.2 MB from `ccoreilly.github.io`) and the Vosk runtime
   (5.8 MB from `cdn.jsdelivr.net`). Nothing happens until you accept.
3. Add the word you're trying to quit. No words ship by default, because there's no universal one.
   You can also **Import phrases from VariableFilter** (copied, not linked).
4. Turn on **Observe mode** for a session or two. Hits are counted silently, so you can tune each
   word from real numbers before the buzzer goes live.
5. Join a call and talk. The status panel shows the gate checklist, a live input meter, and the
   last detection.

The **Toggle MouthWash listening** toolbox action is a quick mute that keeps the model loaded.

## How detection works

```
Discord input device → getUserMedia (2nd capture) → AudioWorklet (48k→16k, 30 ms frames)
   → [transmit gate] → Vosk worker (restricted grammar) → partial / final results
   → HitDetector → cooldowns → reaction (separate AudioContext → your output only)
```

**Engine.** On desktop (Vesktop, Discord desktop), MouthWash always uses Vosk (WASM, running in
its own Web Worker). On-device Web Speech is only considered on Vencord web in a real Chromium
browser, and only when it can be proven and pinned on-device (`processLocally` /
`ondevice-only`). Cloud speech recognition is never used.

> Why not Web Speech on desktop: Electron exposes `SpeechRecognition.available()` to the page but
> implements no browser-side service behind it. Calling it makes Chromium kill the whole Discord
> renderer ("bad Mojo message: No binder found for interface
> media.mojom.OnDeviceSpeechRecognition"). That's a process kill, not an exception, so it can't
> be caught. Desktop builds therefore never touch the API; the call is compiled out.

**Vocabulary.** Vosk decodes against its full 152k-word vocabulary, and MouthWash scans what it
hears for your words. The spec (§6.3) called for the opposite: a *restricted grammar* of only your
words plus a catch-all `[unk]`. Measured, that was far worse. With a few short words to choose
from, the decoder maps ordinary syllables onto them:

| Run through the real engine, 2 TTS voices, words: shit / fuck / rape / damn | Restricted grammar | Open vocabulary |
| --- | --- | --- |
| ~45 s of ordinary talk with **none** of the words, plus sound-alikes ("duck", "dumb", "damp", "grapes", "shift") | **14 and 12 false hits** | **1 and 0** (the one was "damp", flagged as a suspected false alarm) |
| 6 real occurrences | 9 and 10 hits (over-counted) | 6 and 6, all confirmed |
| Processing speed | — | ~7× real time |

So the open vocabulary is the default, and the restricted grammar remains under Advanced for
debugging only. Settings saved with the old default are migrated once.

Every phrase is still checked against the model's vocabulary first, read from the model's own
`Gr.fst`, because a word outside it can never be recognised. A word that isn't in it (e.g.
"yeet") is switched off by itself with a toast naming it. The rest keep working.

**Plurals.** Each word also catches its regular plural by default ("fuck" → "fucks", "bitch" →
"bitches", "pussy" → "pussies"; for a phrase, the last word). Toggle it per word with **Also catch
plurals**. Only the -s family is covered: "fucking" or "fucked" are different words, so add them
explicitly if you want them. A plural only helps if the model's vocabulary has it. In the small
English model, "fucks", "retards", "rapes" and "bitches" are there and were caught in testing;
"shits" and "cunts" are not, so the model hears "shits" as something else ("sits" in testing).
"damns" sounds like "dams", which the model prefers.

**Partial vs final.** A word fires the instant it appears in a *partial* result, because latency
wins. When you finish the phrase, the *final* result checks it. If the final drops the word or
scores it under the word's threshold, the hit is logged as a **suspected false alarm**. The buzzer
can't be un-rung, but the stats show it so you can tune.

**Sensitivity.** Each word has a threshold:

| Threshold | Behaviour |
| --- | --- |
| below 0.95 | fires on partials (fast, ~200–400 ms after the word); finals only audit |
| 0.95 and up | **final-only**: fires only on a confident final result (slower, roughly the end of your sentence, but rarely wrong) |

> Honest note on thresholds: Vosk's final per-word confidences are mostly 1.0 for clearly spoken
> words, so a threshold below 0.95 rarely filters anything. Its real effect is the switch to
> final-only mode at 0.95. Suspected false alarms mostly come from a word being *absent* from the
> final result, not from a low score. If a word still misfires on sound-alikes, set it to
> final-only.

**Transmit gate.** The mic opens once per call (debounced 750 ms, so PTT tapping and mute flicker
don't thrash it). What reaches the recognizer is gated frame by frame on Discord's own `SPEAKING`
signal, so push-to-talk and voice activity are respected exactly. In voice-activity mode, a ~300 ms
pre-roll is handed over when you start transmitting, so Discord's VAD delay doesn't eat the first
syllable.

**Cooldowns.** Per word (default 3 s), plus a global floor (default 1.5 s) across all words, so a
sentence with three target words buzzes once. Hits a cooldown swallows still count in the stats.

## Reactions

| Kind | Notes |
| --- | --- |
| Buzzer (default) | procedural detuned square/saw burst, ~250 ms |
| Sound clip | bundled clips from `assets/`: **Incorrect buzzer**, **LEGO “hey!”**. Inlined in the plugin bundle at build time, so no file read, no network, no CSP |
| Beep | short 880 Hz sine |
| Your file | an audio file you pick (mp3/wav/ogg/opus/flac/m4a/aac/webm, ≤ 10 MB, cut off after 5 s) |
| Speak | on-device TTS voices only (network voices would tell a third party every time you slipped) |
| Toast only / Silent | silent is what Observe mode uses |

Reactions play through their own `AudioContext`, routed to Discord's output device, or to the
device chosen under **Reactions play on**. The target is re-checked before every reaction, so
changing either takes effect immediately. If the target is a virtual device (VB-Cable, Voicemod,
Voicemeeter, …), the panel warns you: a reaction sent there is usually inaudible, and if the cable
feeds your mic chain, the call could hear it. No node is
ever connected to anything that feeds a mic, and Discord transmits from its own native capture,
which that context can't reach. If you're deafened, sounds are skipped but the hit still counts.
Every word can override the global reaction, and every reaction has a **Test** button.

## Measured latency

Measured on 2026‑10‑04 by feeding a Windows TTS recording (Zira voice) through the real
`VoskEngine` and `HitDetector` in headless Chrome, paced in real time, using
`vosk-model-small-en-us-0.15` with the **open vocabulary**:

| Word | Word ended (audio) | Hit reported (audio) | Word offset → hit |
| --- | --- | --- | --- |
| shit ("Oh shit, I missed it") | 0.66 s | 0.93 s | 270 ms |
| fuck | 3.03 s | 3.33 s | 300 ms |
| damn | 4.80 s | 5.01 s | 210 ms |
| rape | 7.98 s | 8.34 s | 360 ms |
| damn | 9.96 s | 10.26 s | 300 ms |
| shit ("Holy shit") | 12.57 s | 12.45 s | fired before the word finished |

That's 210–360 ms, inside the spec's 600 ms target. An earlier run with the restricted grammar
was faster (< 60 ms), but it misfired constantly, which is no use (see **Vocabulary**). Model
load (hash verification, runtime patch, worker start) takes about 1.1 s.

Add on top: 30 ms capture framing, audio-output latency (~10–40 ms), and the extra capture's
processing. **End-to-end in a live call has not been measured yet.** To do it, record your
headset output and the mic together, then measure from the word's offset to the buzzer's onset.
Put the number here.

## Known limitations

- **Short words are unreliable.** "fuck" vs "duck"/"luck"/"truck" at 16 kHz over game audio is
  genuinely hard. Expect to tune, expect some misses, and expect some false alarms.
- **A second microphone capture is open while listening.** Some exclusive-mode drivers and audio
  interfaces will refuse it. Listening then switches off with a banner naming the device. The OS
  mic indicator will show two consumers.
- **Latency isn't zero.** It's good enough for conditioning, not instantaneous.
- **English only in v1.** Only models with a pinned hash can load.
- **Accents and quiet speech** degrade accuracy, as with any small speech model.
- **Discord internals.** Flux event names and `MediaEngineStore` / `RTCConnectionStore` methods are
  internal API. All of them are isolated in `fluxEvents.ts`. If a read fails, the gate fails
  closed. If Discord stops reporting you as speaking while MouthWash clearly hears speech, a
  warning suggests switching **Transmit detection** to **Input level** under Advanced.
- **Device matching.** Discord desktop's native device ids don't always match the browser's.
  MouthWash matches by id, then by name, and otherwise uses the system default. You can pick a
  mic explicitly under Advanced.
- **TTS** always plays on the system default output, not Discord's chosen device.
- **It can't un-say the word.** v1 gives you feedback only. Other people still heard it.

## Implementation notes

- **Vosk runtime.** `vosk-browser@0.0.8` (pinned SHA-256) ships its recognition worker inlined, so
  there's no separate `engine/worker.ts`. After verification, MouthWash applies one deterministic
  edit to that worker: it removes an IndexedDB mount that would otherwise persist an *unverified*,
  extracted copy of the model on every load. The model then lives only in worker memory and is
  gone when the worker is terminated. If the expected line isn't found, the bundle runs unpatched
  and the database is deleted around each load instead.
- **Model cache.** `userData/MouthWash/models/` holds the archive, the runtime, and the extracted word
  list. Everything is re-hashed on every load. **Clear model cache** is under Advanced.
- **Worklet.** It's built from source text (`createResampler.toString()`), because a worklet can't import
  modules. If a CSP ever blocks the blob-URL module, capture falls back to a `ScriptProcessorNode`
  (~20 ms more latency).

## Files

```
index.tsx              definePlugin, flux wiring, toolbox action
controller.ts          runtime: gate → capture → engine → detection → cooldowns → reaction
settings.ts            plugin settings definition
settingsComponents.tsx status panel, word list, reaction editor, stats, advanced, JSON
types.ts               TargetWord, ReactionConfig, shared types
words.ts               pure: word/reaction construction, normalisation, VariableFilter import
native.ts              CSP allowlist, model cache, custom sound read + picker
gate.ts                pure: "should we be listening", SPEAKING parsing, level fallback
fluxEvents.ts          every Discord event name and store read, isolated
status.ts / stats.ts   observable runtime status and in-memory session counts
reaction.ts            ReactionPlayer, procedural buzzer, bundled clips
presetSounds.ts        the assets/ clips, inlined at build time
detection.ts           pure: hypotheses + words + thresholds → hits
cooldown.ts            pure: cooldown bookkeeping
audio/capture.ts       getUserMedia, AudioContext, worklet wiring, teardown
audio/worklet.ts       worklet source as a string
audio/resample.ts      pure: streaming 48k → 16k resampler
audio/devices.ts       Discord device → web device id
engine/index.ts        engine resolution and the backend interface
engine/webspeech.ts    on-device Web Speech backend
engine/vosk.ts         Vosk host, lexicon check, grammar build/rebuild/bisect
engine/voskRuntime.ts  pure: runtime patch + evaluation
engine/lexicon.ts      pure: streaming tar.gz + OpenFst symbol table → vocabulary
engine/modelCache.ts   pinned download, hash verification, cache via native
```

## Tests

```sh
npx tsx --test src/userplugins/mouthWash/*.test.ts src/userplugins/mouthWash/**/*.test.ts
```

Every pure module has a suite: detection, cooldowns, gate, words, resampler, lexicon, and the
runtime patch. Two suites also run against the real downloaded files when these are set:

```sh
MOUTHWASH_MODEL_ARCHIVE=path/to/vosk-model-small-en-us-0.15.tar.gz
MOUTHWASH_VOSK_RUNTIME=path/to/vosk.js
```
