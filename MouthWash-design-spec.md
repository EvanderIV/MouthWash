# MouthWash — Design Spec

**Target:** Vencord plugin (TypeScript/TSX), runs inside Vesktop/Vencord client
**Audience:** Implementing agent — this doc should be sufficient to build the plugin without
further clarification. Where a judgment call was made, the reasoning is included so it can be
revisited.
**Sibling:** `VariableFilter` (same userplugins tree). MouthWash is a **separate plugin**, not a
feature of it — see §1.2.

---

## 1. Purpose

### 1.1 What it does

The user is trying to break a verbal habit — a filler word, a slur, a curse, a verbal tic — and
wants immediate negative feedback when they say it **out loud in a voice call**. MouthWash
listens to the user's own microphone while they are transmitting in a VC, watches for a
user-defined list of target words, and fires a user-configured reaction (by default a short,
unpleasant buzzer audible only to the user) within a fraction of a second of the word being said.

This is a self-directed habit-training tool. It is explicitly **not**:

- a moderation tool — it never listens to, transcribes, or acts on anyone else's audio;
- a transcription or recording tool — audio is processed in a rolling buffer and discarded;
- a network service — no audio, text, or detection event ever leaves the machine.

### 1.2 Why this is a separate plugin from VariableFilter

VariableFilter intercepts outgoing **messages** via a pre-send hook. MouthWash intercepts
outgoing **speech** via a continuous audio pipeline. They share a conceptual model ("a list of
things I'm trying not to emit") but share no runtime machinery, and MouthWash drags in a ~40 MB
WASM speech model that must not load for users who only want text filtering.

**Required seam:** MouthWash may *optionally* read VariableFilter's `phrase` rules as a source
of target words (§5.4). This is a one-way, defensive read — MouthWash must function normally
when VariableFilter is absent or disabled.

### 1.3 The conditioning constraint (drives most design decisions)

The stated purpose is behavioural conditioning. Operant conditioning requires tight temporal
coupling between behaviour and stimulus — practically, **under ~1 second**, ideally under 500 ms.
A buzzer that arrives two seconds after the word is a notification, not a correction.

This single requirement is why the spec mandates streaming recognition with a restricted
grammar (§6) over a batch model like Whisper, and why §13 treats end-to-end latency as a
first-class acceptance criterion rather than a nice-to-have.

## 2. Goals

- Detect a configured spoken word in the user's own microphone input, in near-real-time.
- Fire a configurable reaction within 1 second of the word being spoken (target: < 600 ms).
- Only listen while the user is actually transmitting voice to other people (§7).
- Run entirely on-device. No audio, no transcripts, no telemetry leaves the client, ever.
- Be honestly configurable about false positives — a loud buzzer on a misfire is actively
  disruptive, so sensitivity must be tunable per word and the plugin must ship conservative.
- Degrade safely: if the speech backend is unavailable, the plugin disables itself with a clear
  explanation rather than silently doing nothing or breaking voice chat.

## 3. Non-goals

- Not a general transcription feature. No transcript is surfaced, stored, or exported.
- Not multi-speaker. Only the local user's microphone is ever opened.
- Not a "censor the outgoing audio" tool. v1 does **not** mute, bleep, duck, or otherwise modify
  what other people hear. The reaction is feedback to the user only. (See §14 for why
  outbound muting is deliberately deferred.)
- Not a cross-language solution in v1. English models only; the architecture allows other Vosk
  models but the UI ships English.
- Not guaranteed-accurate. Short words in noisy conditions are genuinely hard; this is a nudge,
  not a detector you could build an enforcement system on. Document this plainly in the plugin
  `description`.

## 4. User stories

1. As a user trying to stop saying "like" as filler, I want a short buzzer in my own headphones
   the moment I say it in a VC, so I notice the habit in the act rather than afterwards.
2. As a user, I want nothing to happen when I'm muted, not in a call, or not pressing my
   push-to-talk key — the point is not saying it *to people*, and I don't want to be buzzed while
   talking to myself.
3. As a user, I want to tune how twitchy each word is, because "fuck" against "duck"/"luck" is a
   much harder call than a distinctive three-syllable word.
4. As a user, I want to be certain this is not recording me or sending audio anywhere, and I want
   that verifiable from the settings panel, not just promised in a README.
5. As a user, I want the buzzer to go to my headphones only and never into the call — being heard
   buzzing myself is funny exactly once.
6. As a user, I want to see that it's actually listening (and when it last fired) so I can trust
   it is working without having to swear experimentally.

## 5. Data model

### 5.1 Target word

```ts
interface TargetWord {
    id: string;              // stable uuid
    /** the word or short phrase to listen for, lowercase, as spoken */
    phrase: string;
    /** 0..1 — minimum recognizer confidence required to count as a hit.
     *  Higher = fewer false positives, more misses. Default 0.75 (see §6.5). */
    threshold: number;
    /** per-word reaction override; falls back to the global reaction when null */
    reaction: ReactionConfig | null;
    /** milliseconds to ignore repeat hits of THIS word after it fires (default 3000) */
    cooldownMs: number;
    enabled: boolean;
    /** rolling count, local only, resettable — powers the stats panel (§9) */
    hitCount: number;
}
```

`phrase` must be lowercase ASCII letters, digits and single spaces. The grammar builder (§6.3)
rejects anything else, because Vosk grammars are tokenised on whitespace and an out-of-vocabulary
token poisons the whole grammar (§6.4).

### 5.2 Reaction

```ts
type ReactionKind = "buzzer" | "beep" | "customSound" | "toast" | "tts" | "silent";

interface ReactionConfig {
    kind: ReactionKind;
    /** 0..1 output gain for sound reactions */
    volume: number;
    /** for kind === "customSound": a file path chosen by the user (read via native, §8.4) */
    soundPath?: string;
    /** for kind === "tts": what to say, e.g. "you said like" */
    ttsText?: string;
    /** also show a toast naming the word, regardless of kind */
    alsoToast: boolean;
}
```

`silent` exists so a user can run in "observe mode" — accumulate stats without being buzzed —
which is the recommended way to tune thresholds (§9.2).

### 5.3 Persisted settings

```ts
interface MouthWashSettings {
    words: TargetWord[];
    defaultReaction: ReactionConfig;

    /** master switch, separate from the plugin being enabled (§7.4) */
    listening: boolean;

    // gating (§7)
    requireVoiceConnection: boolean;   // default true
    requireUnmuted: boolean;           // default true
    requireTransmitting: boolean;      // default true  (respects PTT / voice activity)
    listenInDMCalls: boolean;          // default true

    // engine (§6)
    engine: "auto" | "webspeech" | "vosk";   // default "auto"
    modelId: string;                         // default "vosk-model-small-en-us-0.15"
    useRestrictedGrammar: boolean;           // default true — see §6.3

    // feedback & safety
    globalCooldownMs: number;          // default 1500, floor across all words
    inputDeviceId: string | null;      // null = follow Discord's selected input (§8.1)

    showStats: boolean;                // default true
}
```

### 5.4 Optional import from VariableFilter

A button in settings, **not** a live binding: "Import phrases from VariableFilter". It reads
`Vencord.Settings.plugins.VariableFilter?.rules`, takes entries where `matchKind === "phrase"`
and `!isRegex`, and offers them as new `TargetWord`s for the user to confirm.

Rationale for copy-not-link: VariableFilter rules are regex-capable and scoped per guild; neither
concept transfers to speech. Silently inheriting them would produce surprising audio behaviour.
Wrap the whole read in `try/catch` — VariableFilter may not be installed.

## 6. Speech recognition

### 6.1 Engine selection

`engine: "auto"` resolves at `start()` in this order:

1. **On-device Web Speech API** — if `SpeechRecognition`/`webkitSpeechRecognition` exists *and*
   `SR.availableOnDevice("en-US")` resolves to an available state (Chromium ≥ 139).
2. **Vosk (WASM)** — otherwise.
3. If neither is usable, the plugin disables itself and shows a persistent error (§10.3).

**Critical:** cloud Web Speech must never be used. Chrome's classic `webkitSpeechRecognition`
streams audio to Google. In Electron it usually fails outright (no API key), but if it ever
succeeds it would silently ship the user's microphone to a third party — the exact thing §2
promises against. The implementation **must** verify `availableOnDevice()` returns an on-device
state and **must not** fall back to network recognition if it doesn't. If `availableOnDevice` is
absent, treat Web Speech as unavailable, full stop.

### 6.2 Why Vosk and not Whisper

| | Vosk (small en-us) | Whisper-tiny via transformers.js |
| --- | --- | --- |
| Mode | streaming, incremental | batch over a chunk |
| Latency to first hypothesis | ~200–400 ms | ~1–3 s per chunk |
| Restricted vocabulary | yes (§6.3) | no |
| Model size | ~40 MB | ~40–75 MB |
| Accuracy, open vocabulary | lower | higher |

Whisper is more accurate but structurally cannot meet §1.3, because it cannot emit a hypothesis
until the chunk closes. Vosk's partial results are what make sub-second reaction possible. The
accuracy gap largely closes once the grammar is restricted (§6.3).

### 6.3 Restricted grammar (the key optimisation)

Do **not** run open-vocabulary recognition. Vosk's `KaldiRecognizer` accepts a JSON array that
constrains decoding to a fixed vocabulary:

```ts
const grammar = JSON.stringify([...enabledPhrases, "[unk]"]);
const recognizer = new model.KaldiRecognizer(SAMPLE_RATE, grammar);
```

`"[unk]"` is the mandatory garbage bucket that absorbs everything else. Effects:

- far fewer false positives — the decoder can only output your words or `[unk]`;
- much lower CPU, because the search space is tiny;
- faster, more confident partials.

This is what turns "run general ASR inside Discord" (hard) into "keyword spotting" (tractable).
Expose `useRestrictedGrammar` as a setting but default it on; off is for debugging only.

**Rebuild the grammar whenever the enabled word set changes.** A `KaldiRecognizer` cannot be
re-grammared in place — tear it down and construct a new one (§8.3).

### 6.4 Grammar validation

Every phrase must be in the model's lexicon. An unknown token makes Vosk reject the grammar and
throw, which would take down the whole pipeline. Therefore:

- validate each phrase against `^[a-z0-9]+( [a-z0-9]+)*$` in the UI, rejecting on input;
- wrap recognizer construction in `try/catch`; on failure, bisect — rebuild the grammar dropping
  one phrase at a time — to identify the offending phrase, disable **only** that word, and toast
  the user naming it (mirrors VariableFilter's invalid-regex handling);
- never let a single bad phrase disable the whole plugin.

### 6.5 Hit detection

Consume **both** partial and final results.

- **Partial results** (`recognizer.on("partial")`) drive latency. Scan the partial text for any
  enabled phrase as a whole-word match. Vosk partials carry no per-word confidence, so a partial
  hit is provisional.
- **Final results** (`recognizer.on("result")`) carry `result[].conf` per word. Use these to
  confirm and to gate on `threshold`.

Recommended policy, tunable:

1. On a **partial** hit, fire the reaction immediately (latency wins) and mark the word
   `pendingConfirmation`.
2. On the next **final** result, if the word is absent or its `conf < threshold`, record a
   *suspected false positive* in the stats panel. Do not retract the buzzer — you cannot unring
   it — but surface the miss so the user can raise the threshold.
3. If `threshold >= 0.95`, switch that word to **final-only** mode: do not fire on partials at
   all. This gives users an explicit accuracy-over-latency lever.

Document this tradeoff in the settings UI. It is the single most important thing for the user to
understand about tuning.

### 6.6 Audio format

Vosk expects **16 kHz mono PCM**. Discord's capture is typically 48 kHz. Resample in the
AudioWorklet (§8.2) — do not rely on `AudioContext({sampleRate: 16000})`, which is unreliable
across platforms and can fail to honour the request. Downsample 48 k → 16 k by decimation with a
simple low-pass, or use an `OfflineAudioContext` resample; correctness matters more than fidelity
at this sample rate.

## 7. Gating — when to listen

MouthWash must be **inert** unless all enabled conditions hold. This is both a privacy guarantee
and a CPU saving, and it encodes user story 2.

| Condition | Setting | Source |
| --- | --- | --- |
| Connected to a voice channel | `requireVoiceConnection` | `RTCConnectionStore.isConnected()`, `getChannelId()` |
| Not self-muted or server-muted | `requireUnmuted` | `MediaEngineStore.isSelfMute()`, `isMute()` |
| Actually transmitting right now | `requireTransmitting` | see §7.1 |
| Call is a DM/group call | `listenInDMCalls` | `ChannelStore.getChannel(rtcChannelId)?.guild_id == null` |
| Master switch on | `listening` | settings |

Re-evaluate on every relevant Flux event, via `definePlugin({ flux: { ... } })`:

```ts
flux: {
    RTC_CONNECTION_STATE(e) { MouthWash.reevaluateGate(); },
    AUDIO_TOGGLE_SELF_MUTE() { MouthWash.reevaluateGate(); },
    AUDIO_TOGGLE_SELF_DEAF() { MouthWash.reevaluateGate(); },
    VOICE_STATE_UPDATES() { MouthWash.reevaluateGate(); },
    SPEAKING(e) { MouthWash.onSpeakingChange(e); }
}
```

Event names are internal Discord API surface and may drift between versions. Isolate every one of
them in a single `fluxEvents.ts` so a rename is a one-file fix (same approach VariableFilter uses
for its attachment lookup). If an expected event never fires, the gate must **fail closed** —
not listening — and log once.

### 7.1 Transmission detection

Preferred: subscribe to the `SPEAKING` Flux event filtered to the current user's ID
(`UserStore.getCurrentUser().id`), which reflects Discord's own voice-activity/PTT decision and
therefore automatically respects the user's PTT key and VAD threshold.

Fallback if that proves unreliable: compute RMS in the worklet and gate on a configurable
threshold. This is strictly worse — it duplicates Discord's VAD and will disagree with it — so
treat it as a debugging fallback, not the default.

### 7.2 Opening and closing the stream

Open the microphone **only** when the gate first becomes satisfied; fully stop all tracks
(`stream.getTracks().forEach(t => t.stop())`) and `close()` the `AudioContext` the moment it
stops being satisfied. Do not keep a hot stream between calls. On Windows this means the mic
indicator reflects reality, which matters for user story 4.

Debounce gate transitions by ~750 ms so PTT tapping doesn't thrash `getUserMedia`.

### 7.3 Second capture, not a tap

Use an independent `navigator.mediaDevices.getUserMedia({ audio: {...} })` capture rather than
tapping Discord's internal media engine stream. This is the same approach
`src/plugins/voiceMessages/WebRecorder.tsx` uses, and it is far more robust than patching
Discord's WebRTC internals, which change often.

Request with `echoCancellation: true, noiseSuppression: true, autoGainControl: true` — these
improve recognition and match what Discord sends, so the recognizer hears roughly what the call
hears.

**Known consequence to document (§11):** this is a second concurrent mic capture. On most Windows
setups that is fine (shared mode), but exclusive-mode drivers and some interfaces will refuse.
Handle `getUserMedia` rejection gracefully (§10.3).

### 7.4 `listening` vs plugin enabled

Keep them separate. `listening` is a quick, discoverable mute for the feature that doesn't
require toggling the plugin (which would tear down the model and force a re-download/reload).
Surface it as a toolbox action (`toolboxActions`) so it's reachable without opening settings.

## 8. Architecture

### 8.1 Pipeline

```
getUserMedia (16k-resampled)
        │
        ▼
  AudioContext ── MediaStreamSource ── AudioWorkletNode ("mouthwash-tap")
        │                                      │
        │                          postMessage(Float32Array frames)
        ▼                                      ▼
   [gate: §7]                          Worker ("recognizer")
                                               │  Vosk WASM + model
                                               │  restricted grammar (§6.3)
                                               ▼
                                     partial / final results
                                               │
                                               ▼
                                   HitDetector (§6.5, cooldowns §10.2)
                                               │
                                               ▼
                                   ReactionPlayer (§10.1) ── separate AudioContext
                                                             → output device only
```

Hard requirement: recognition runs in a **Worker**, never on the main thread. Blocking Discord's
renderer would stutter the UI and the call itself.

`inputDeviceId: null` should resolve to `MediaEngineStore.getInputDeviceId()` so MouthWash
follows whatever input Discord is using, rather than the OS default.

### 8.2 The AudioWorklet

`worklet.js` is a string injected via `audioContext.audioWorklet.addModule(URL.createObjectURL(...))`
— a bundled separate file will not resolve correctly inside Discord's renderer. Responsibilities,
deliberately minimal (it runs on the audio thread; anything slow causes dropouts):

1. accumulate 128-sample render quanta into ~30 ms frames;
2. downsample 48 k → 16 k (§6.6);
3. compute frame RMS (for the level meter in §9 and the §7.1 fallback);
4. `postMessage` the Float32Array to the main thread, which forwards to the worker.

No allocation in the hot path beyond the frame buffer; reuse buffers.

### 8.3 Lifecycle

- `start()` — read settings, resolve engine (§6.1), register Flux handlers, evaluate gate. **Do
  not** download the model yet (§8.5).
- gate satisfied → ensure model loaded → open mic → build recognizer with current grammar.
- word list changed while running → rebuild recognizer (§6.3) without reopening the mic.
- gate unsatisfied → stop tracks, close `AudioContext`, keep the model in memory.
- `stop()` — stop everything, terminate the worker, free the model, remove all listeners. Must
  leave no open mic, no live `AudioContext`, and no running worker. This is explicitly tested
  (§13).

### 8.4 Native module (`native.ts`)

Required for two things:

1. **CSP allowlisting.** `src/main/csp/index.ts` states plugins may whitelist their own domains
   by importing `CspPolicies` in their `native.ts`. Add the model/runtime host with
   `ImageScriptsAndCssSrc` (which includes `script-src` and `worker-src`) plus `ConnectSrc`:

   ```ts
   import { ConnectSrc, CspPolicies, ImageScriptsAndCssSrc } from "@main/csp";
   CspPolicies["alphacephei.com"] ??= ConnectSrc; // official Vosk model host
   ```

   `cdn.jsdelivr.net` is **already** allowlisted with `ImageScriptsAndCssSrc`, and that constant
   transitively contains `connect-src` (`ConnectSrc` → `ImageSrc` → `ImageAndCssSrc` →
   `ImageScriptsAndCssSrc`), so loading the Vosk runtime *and* `fetch`ing from jsDelivr both
   already pass. Only a non-jsDelivr model host needs a new entry.

   The `@main/*` path alias is configured in `tsconfig.json`, so this import resolves from a
   userplugin.

2. **Model caching on disk.** Downloading 40 MB on every client start is unacceptable. Cache
   under Electron's `app.getPath("userData")/MouthWash/models/`, exposing:

   ```ts
   export async function getCachedModel(_: IpcMainInvokeEvent, id: string): Promise<ArrayBuffer | null>
   export async function cacheModel(_: IpcMainInvokeEvent, id: string, data: ArrayBuffer): Promise<void>
   export async function clearModelCache(_: IpcMainInvokeEvent): Promise<void>
   export async function readCustomSound(_: IpcMainInvokeEvent, path: string): Promise<ArrayBuffer | null>
   ```

   Consumed in the renderer as:

   ```ts
   const Native = VencordNative.pluginHelpers.MouthWash as PluginNative<typeof import("./native")>;
   ```

   Verify the SHA-256 of a downloaded model before caching it, and refuse to load a model whose
   hash doesn't match the pinned value. Fetching executable model weights over the network and
   feeding them to a WASM runtime without verification is the one genuinely dangerous thing this
   plugin does.

   `readCustomSound` must reject paths outside a user-chosen file (no arbitrary FS read driven by
   settings JSON) — validate it is an existing regular file with an audio extension.

### 8.5 First-run model download

Never download implicitly. On first enable, show an explicit prompt stating the size, the host,
and that it is a one-time download cached locally. Provide a progress indicator and a cancel.
Until the user accepts, the plugin stays inert and says so in settings.

If Web Speech on-device was selected (§6.1), skip all of this — no download, no CSP, no native
module needed for recognition.

## 9. Settings UI

Follow the structure and component vocabulary already used by `VariableFilter`'s
`settingsComponents.tsx` — `definePluginSettings` with an `OptionType.COMPONENT` manager, Vencord
components (`@components/Button`, `Card`, `ExpandableCard`, `FormSwitch`, `Heading`, `Paragraph`,
`Span`, `Switch`, `Flex`), `classNameFactory("vc-mw-")`, and a forced re-render after in-place
mutation of settings arrays.

### 9.1 Status panel (top, always visible)

The trust surface for user story 4 and 6. Shows, live:

- engine in use ("On-device Web Speech" / "Vosk, model X") or why it's unavailable;
- gate state as a checklist with the failing condition highlighted — "In a voice call ✓ /
  Unmuted ✓ / Transmitting ✗ — not listening";
- a live input level meter while listening (drives home that audio is being processed);
- an explicit line: **"Audio is processed on this device and never leaves it. Nothing is
  recorded."**
- last detection: word + relative time.

### 9.2 Word list

Rows: phrase, threshold, hit count, enabled toggle, delete. Expanding gives threshold slider
(with plain-language labels: "twitchy ← → strict"), cooldown, per-word reaction override, and a
**Test** button that plays that word's reaction so the user can set volume without swearing into
a live call.

Include a prominent **Observe mode** affordance: set the global reaction to `silent` and let hit
counts accumulate for a session, then tune thresholds from real data. Recommend this in the UI as
the way to onboard, because blind threshold-guessing plus a loud buzzer is a bad first experience.

### 9.3 Reaction editor

Kind selector, volume slider with live preview, custom sound file picker, TTS text, "also show a
toast". Make the preview button unmistakable and always available.

### 9.4 Stats

Per-word hit counts, suspected false positives (§6.5), hits per session, resettable. Local only,
never persisted beyond the settings file, never transmitted.

### 9.5 Advanced

Engine override, model selector, grammar toggle, gate overrides, "clear model cache", and a raw
JSON escape hatch over `words[]` mirroring VariableFilter §8.4.

## 10. Feedback and safety

### 10.1 Playing the reaction

**The reaction must never enter the outgoing audio stream.** Play it through a dedicated
`AudioContext` whose `sinkId` is the user's *output* device, entirely separate from the capture
graph. Never connect any reaction node to anything that feeds the mic path.

Generate the default buzzer procedurally (a short detuned square/saw burst with a fast envelope,
~250 ms) rather than bundling an audio file — no asset to ship, no CSP for media, and it is
trivially volume-controllable.

Duck or skip the reaction if the user is deafened (they won't hear it anyway) — but still count
the hit.

### 10.2 Cooldowns (mandatory)

Two layers, because repeated buzzing is punishing in a way that destroys trust in the tool:

1. per-word `cooldownMs` (default 3000) — ignore repeats of the same word;
2. `globalCooldownMs` (default 1500) — a floor across *all* words, so a sentence with three
   target words produces one buzzer, not three.

Hits suppressed by cooldown still increment stats.

### 10.3 Failure modes — all must fail safe and loud

| Failure | Behaviour |
| --- | --- |
| No usable engine (§6.1) | Disable, persistent settings banner naming the reason |
| `getUserMedia` rejected (permission / exclusive-mode device) | Disable listening, toast once, banner with the device name |
| Model download fails or hash mismatch | Do not load. Banner offering retry. Never load an unverified model |
| Recognizer construction throws | Bisect grammar (§6.4), disable the offending word only |
| Worker crashes | Restart once with backoff; on repeat failure, disable and report |
| Expected Flux event never fires | Fail closed (not listening), log once |

Nothing in this plugin may throw into Discord's audio path or break voice chat. If MouthWash
cannot work, the call must be completely unaffected.

## 11. Known limitations (document plainly, do not paper over)

- **Short words are unreliable.** "fuck" vs "duck"/"luck"/"truck" at 16 kHz over game audio is a
  genuinely hard discrimination. Expect to tune thresholds per word; expect some misses and some
  false positives. State this in the plugin description.
- **A second microphone capture is open while listening.** Some exclusive-mode audio devices will
  refuse it. The OS mic indicator will reflect two consumers.
- **Latency is not zero.** Realistically 300–600 ms on the Vosk path. Good enough for
  conditioning, not instantaneous.
- **English only in v1.**
- **Accents and quiet speech degrade accuracy**, as with any small ASR model.
- **Flux event names and `MediaEngineStore`/`RTCConnectionStore` methods are internal API** and
  may need maintenance after Discord updates. Isolated per §7 so fixes are localised.
- **It cannot un-say the word.** v1 gives feedback only; other people still heard it.

## 12. Privacy (non-negotiable)

- All processing is on-device. No audio, features, transcripts, hypotheses, or detection events
  are transmitted anywhere, ever. The only network access in the entire plugin is the one-time,
  user-confirmed, hash-verified model download (§8.5).
- **No audio is written to disk at any point.** Frames live in a bounded ring buffer and are
  overwritten. There is no record/replay path, and none may be added.
- **No transcripts are retained.** Recognizer output is matched against the word list and
  discarded in the same tick. Only aggregate counts persist (§9.4).
- Never open the microphone when the gate is unsatisfied (§7.2).
- State all of the above in the plugin `description` so it is visible in the plugin list, and in
  the §9.1 status panel so it is visible in use.

## 13. Acceptance criteria

**Gating**
- [ ] With `requireVoiceConnection`, no microphone is opened while not in a voice call —
      verifiable by the OS mic indicator.
- [ ] Muting mid-call closes the capture within ~1 s; unmuting reopens it.
- [ ] With `requireTransmitting` and push-to-talk, no detection occurs while the key is released.
- [ ] Rapid PTT tapping does not thrash `getUserMedia` (debounce holds).
- [ ] `listening: false` fully stops capture while leaving the model loaded.

**Detection**
- [ ] A configured word spoken normally in a call triggers its reaction.
- [ ] Measured end-to-end latency (word offset → reaction onset) is **under 1 s**, target 600 ms.
      Measure it; record the number in the README.
- [ ] A word not in the list never triggers, with the restricted grammar on.
- [ ] Raising a word's threshold to 0.95 switches it to final-only and measurably reduces false
      positives.
- [ ] Per-word and global cooldowns both hold; a sentence with three target words fires once.
- [ ] Disabling a word rebuilds the grammar and stops detecting it without reopening the mic.

**Safety**
- [ ] An invalid phrase disables only that word, names it in a toast, and leaves the rest working.
- [ ] A hash-mismatched model is refused.
- [ ] Denying microphone permission disables listening with a clear message and does not break VC.
- [ ] The reaction is audible to the user and **inaudible to others in the call** — verify with a
      second account.
- [ ] Disabling the plugin leaves no open mic, no live `AudioContext`, and no running worker.
- [ ] No file is ever written containing audio or transcript text.
- [ ] With the plugin enabled but no model downloaded, the client behaves completely normally.

## 14. Future enhancements (explicitly out of scope for v1)

- **Outbound suppression** — mute/bleep the outgoing stream for the duration of the word.
  Deferred deliberately: it requires intercepting Discord's transmit path rather than a parallel
  capture, and detection latency means the word's onset is already transmitted, so it would
  half-work in a way that gives false confidence.
- Escalating reactions (louder on repeat within a session).
- Streak tracking / "days since last slip".
- Non-English models.
- Phoneme-level matching for words outside the model lexicon.
- Per-guild word lists, mirroring VariableFilter's scoping.
- A calibration wizard that has the user say each word five times to auto-set thresholds.

## 15. File/module structure

```
MouthWash/
  index.tsx              — definePlugin, flux handlers, lifecycle, toolbox action
  types.ts               — TargetWord, ReactionConfig, settings types
  settings.ts            — definePluginSettings
  native.ts              — CSP allowlist, model cache, custom sound read (§8.4)

  gate.ts                — all "should we be listening" logic (§7), pure where possible
  fluxEvents.ts          — isolated Discord event-name surface (§7)

  audio/capture.ts       — getUserMedia, AudioContext, worklet wiring, teardown
  audio/worklet.ts       — worklet source as a string (§8.2)
  audio/resample.ts      — 48k → 16k, pure, unit-testable

  engine/index.ts        — engine resolution (§6.1)
  engine/webspeech.ts    — on-device Web Speech backend
  engine/vosk.ts         — Vosk worker host, grammar build/rebuild
  engine/worker.ts       — the recognition worker itself
  engine/modelCache.ts   — download, hash-verify, cache via native

  detection.ts           — pure: hypothesis + word list + thresholds → hits (§6.5)
  cooldown.ts            — pure: cooldown bookkeeping (§10.2)
  reaction.ts            — ReactionPlayer, procedural buzzer (§10.1)
  stats.ts               — in-memory counters (§9.4)

  settingsComponents.tsx — status panel, word list, reaction editor, stats, advanced
  styles.css
  README.md
```

`detection.ts`, `cooldown.ts` and `audio/resample.ts` must have **no Vencord, webpack, or DOM
imports**, so they can be unit-tested against fixed inputs — the same discipline VariableFilter
applies to its `matching.ts`, which is what made its 91-assertion suite possible.

## 16. Implementation order

Build in this order; each step is independently verifiable.

1. **Skeleton** — `definePlugin`, settings, empty settings panel. Verify it loads.
2. **Gate** (§7) — no audio yet. Render the gate checklist live in the status panel and confirm
   it tracks joining/leaving/muting correctly. This is the cheapest thing to get right and the
   most annoying to debug later.
3. **Capture** (§8.2) — open the mic under the gate, run the worklet, display the level meter.
   Confirm clean teardown. Still no recognition.
4. **Reaction** (§10.1) — procedural buzzer, test button, output-device routing. Verify with a
   second account that it is not audible in the call.
5. **Engine detection** (§6.1) — resolve and display the engine, no recognition yet.
6. **Recognition** — Web Speech path first if available (far simpler); otherwise Vosk worker,
   model download, grammar.
7. **Detection + cooldowns** (§6.5, §10.2) — pure modules with unit tests before wiring in.
8. **Stats, tuning UI, JSON escape hatch, README.**

Before step 6, run the §6.1 diagnostic in Discord's DevTools to learn which path applies:

```js
console.log("chrome:", process.versions?.chrome, "electron:", process.versions?.electron);
const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
console.log("SpeechRecognition present:", !!SR);
SR?.availableOnDevice?.("en-US").then(r => console.log("on-device:", r))
  ?? console.log("on-device API: not present");
```

## 17. Plugin metadata

```ts
name: "MouthWash"
description:
  "Listens to your own microphone while you're talking in a voice call and plays a sound you " +
  "choose when you say a word you're trying to stop saying. Everything runs on your device — " +
  "no audio, text, or detection ever leaves the client, and nothing is recorded. Only your own " +
  "mic is ever opened, never anyone else's. Short words are hard to detect reliably; expect to " +
  "tune it."
tags: ["Voice", "Utility", "Privacy"]
```

Do not ship any default words. There is no universal "word everyone is trying to quit", and an
empty list with a clear call to action is the correct first-run state (same reasoning as
VariableFilter §8.3).
