/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The runtime: gate → capture → engine → detector → cooldowns → reaction (§8.1, §8.3).
 *
 * Lifecycle:
 *  - start(): resolve the engine and evaluate the gate. Nothing is downloaded and no mic opens.
 *  - gate satisfied (debounced 750 ms) → ensure the engine is loaded → open the mic.
 *  - word list changed → rebuild the grammar without reopening the mic.
 *  - gate unsatisfied (debounced) → stop the tracks and close the AudioContext; keep the model.
 *  - stop(): close everything, terminate the worker, free the model, drop every listener.
 *
 * Every entry point is wrapped so a failure here degrades MouthWash, never Discord's voice.
 */

import { Logger } from "@utils/Logger";
import { showToast } from "@webpack/common";

import { Capture, CaptureError } from "./audio/capture";
import { resolveWebDevice } from "./audio/devices";
import { CooldownTracker } from "./cooldown";
import { type DetectionEvent, HitDetector, phraseError, phraseVariants } from "./detection";
import { type EngineCallbacks, type EngineResolution, type RecognitionEngine, resolveEngine } from "./engine";
import { downloadBundle, formatMB, getModel, HashMismatchError, isBundleCached, ModelMissingError, totalDownloadBytes } from "./engine/modelCache";
import { VoskEngine } from "./engine/vosk";
import { WebSpeechEngine } from "./engine/webspeech";
import { getDiscordInputDevice, isDeafened, isPushToTalk, logOnce, readGateInputs, subscribeDiscord, unsubscribeDiscord } from "./fluxEvents";
import { evaluateGate, type GateResult, LevelGate } from "./gate";
import { reactionPlayer } from "./reaction";
import { settings } from "./settings";
import { recordConfirmed, recordHit, recordSuspected, resetSession } from "./stats";
import { getStatus, resetStatus, setLevel, setStatus } from "./status";
import type { FinalResult, ReactionConfig, TargetWord } from "./types";
import { effectiveReaction, normalizeReactionInPlace, normalizeWordList } from "./words";

const logger = new Logger("MouthWash");

/** §7.2: so push-to-talk tapping or a mute flicker cannot thrash getUserMedia */
const GATE_DEBOUNCE_MS = 750;
/** voice-activity mode only: audio kept from just before Discord's VAD fires (10 × 30 ms) */
const PREROLL_FRAMES = 10;
/** Web Speech hears continuously; accept its results this long after transmission ends */
const WEBSPEECH_TAIL_MS = 500;
const WORDS_DEBOUNCE_MS = 300;
const CRASH_BACKOFF_MS = 2000;
/** ~6 s of clearly-voiced frames with no SPEAKING event → the event has probably been renamed */
const SPEAKING_SUSPICION_FRAMES = 200;
const SPEAKING_SUSPICION_RMS = 0.04;

let running = false;

const detector = new HitDetector();
const cooldowns = new CooldownTracker();
const levelGate = new LevelGate();

let resolution: EngineResolution | null = null;
let engine: RecognitionEngine | null = null;
let engineLoading: Promise<RecognitionEngine | null> | null = null;
let crashRestarts = 0;
let engineFailed = false;
let engineGeneration = 0;

let capture: Capture | null = null;
let captureBusy = false;
let captureTimer: ReturnType<typeof setTimeout> | null = null;
let wantCapture = false;

let gate: GateResult | null = null;
let transmittingDiscord = false;
let transmittingLevel = false;
let feeding = false;
let feedingEndedAt = -Infinity;
const preroll: Float32Array[] = [];

let speakingSeen = false;
let loudFramesWithoutSpeaking = 0;

let wordsTimer: ReturnType<typeof setTimeout> | null = null;
let download: AbortController | null = null;

const newId = () => crypto.randomUUID();

// #region helpers

function safely<A extends unknown[]>(name: string, fn: (...args: A) => void) {
    return (...args: A) => {
        try {
            fn(...args);
        } catch (e) {
            logger.error(`${name} failed`, e);
        }
    };
}

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

function gateSettings() {
    const s = settings.store;
    return {
        listening: s.listening,
        requireVoiceConnection: s.requireVoiceConnection,
        requireUnmuted: s.requireUnmuted,
        requireTransmitting: s.requireTransmitting,
        listenInDMCalls: s.listenInDMCalls
    };
}

const currentTransmitting = () => settings.store.transmitSource === "level" ? transmittingLevel : transmittingDiscord;

/** Words that should be listened for: enabled, valid, and not refused by the engine. */
function activeWords(): TargetWord[] {
    const { rejected } = getStatus();
    return (settings.store.words ?? []).filter(w => w.enabled && !phraseError(w.phrase) && !rejected[w.id]);
}

/** The engine can run (or be loaded) right now without user action. */
function engineUsable(): boolean {
    const state = getStatus().engineState;
    return !engineFailed && (state === "ready" || state === "standby" || state === "loading");
}

// #endregion

// #region lifecycle

export async function start(): Promise<void> {
    running = true;
    engineFailed = false;
    crashRestarts = 0;
    resetStatus();
    resetSession();
    setStatus({ running: true });

    try {
        normalizeSettings();
    } catch (e) {
        logger.error("Failed to normalise settings", e);
    }

    subscribeDiscord({
        onStateChanged: safely("reevaluateGate", reevaluateGate),
        onSpeaking: safely("onSpeaking", onSpeaking)
    });

    reevaluateGate();
    await resolve();
}

export function stop(): void {
    running = false;
    engineGeneration++;

    if (captureTimer) clearTimeout(captureTimer);
    if (wordsTimer) clearTimeout(wordsTimer);
    captureTimer = wordsTimer = null;

    download?.abort();
    download = null;

    unsubscribeDiscord();
    closeCapture();
    disposeEngine();
    reactionPlayer.dispose();

    detector.reset();
    cooldowns.reset();
    levelGate.reset();
    transmittingDiscord = transmittingLevel = feeding = false;
    gate = null;

    resetStatus();
}

/**
 * A plain deep copy of a settings value. Reading through `settings.store` yields the store's
 * proxies, and assigning one back stores the proxy itself in the settings object; the next save
 * then fails to clone it over IPC, and every settings write after that throws.
 */
const plainCopy = <T>(value: T): T => value == null ? value : JSON.parse(JSON.stringify(value));

function normalizeSettings() {
    const s = settings.store;
    s.words = normalizeWordList(plainCopy(s.words), newId);
    s.defaultReaction = normalizeReactionInPlace(s.defaultReaction && typeof s.defaultReaction === "object" ? plainCopy(s.defaultReaction) : {});
    // v1: the restricted grammar used to be the default and was saved explicitly; it misfires
    // on ordinary speech, so move everyone to the open vocabulary once. A user who turns it back
    // on afterwards keeps that choice.
    if ((s.settingsVersion ?? 0) < 1) {
        s.useRestrictedGrammar = false;
        s.settingsVersion = 1;
    }

    if (!["auto", "webspeech", "vosk"].includes(s.engine)) s.engine = "auto";
    if (!["discord", "level"].includes(s.transmitSource)) s.transmitSource = "discord";
    if (typeof s.globalCooldownMs !== "number" || !(s.globalCooldownMs >= 0)) s.globalCooldownMs = 1500;
    if (typeof s.rmsThreshold !== "number" || !(s.rmsThreshold > 0)) s.rmsThreshold = 0.02;
    try {
        getModel(s.modelId);
    } catch {
        s.modelId = "vosk-model-small-en-us-0.15";
    }
}

/** Resolve the engine (§6.1). Does not download or load a model. */
async function resolve(): Promise<void> {
    const generation = ++engineGeneration;
    setStatus({ engineState: "resolving", engineLabel: "Checking speech engines…", engineDetail: null, banner: null });

    const r = await resolveEngine(settings.store.engine);
    if (!running || generation !== engineGeneration) return;
    resolution = r;

    if (!r.kind) {
        setStatus({
            engineKind: null,
            engineState: "unavailable",
            engineLabel: "No speech engine available",
            engineDetail: r.reason,
            banner: { message: `MouthWash can't listen: ${r.reason}` }
        });
        reevaluateGate();
        return;
    }

    if (r.kind === "webspeech") {
        setStatus({ engineKind: "webspeech", engineState: "standby", engineLabel: "On-device Web Speech", engineDetail: r.reason });
    } else {
        const model = getModel(settings.store.modelId);
        const cached = await isBundleCached(model.id).catch(() => false);
        if (!running || generation !== engineGeneration) return;

        setStatus({
            engineKind: "vosk",
            engineState: cached ? "standby" : "needsModel",
            engineLabel: `Vosk, model ${model.id}`,
            engineDetail: cached
                ? `${r.reason} Model verified on disk; it loads the first time you're in a call.`
                : `${r.reason} The speech model hasn't been downloaded yet (${formatMB(totalDownloadBytes(model.id))}).`
        });
    }

    reevaluateGate();
}

/** Tear down and re-resolve — after the engine, model or grammar setting changes. */
export function reloadEngine(): void {
    if (!running) return;
    closeCapture();
    disposeEngine();
    engineFailed = false;
    crashRestarts = 0;
    setStatus({ rejected: {} });
    void resolve();
}

function disposeEngine() {
    engineGeneration++;
    engineLoading = null;
    try {
        engine?.dispose();
    } catch (e) {
        logger.error("Engine dispose failed", e);
    }
    engine = null;
    detector.reset();
}

// #endregion

// #region gate

export function reevaluateGate(): void {
    if (!running) return;

    const inputs = { ...readGateInputs(), transmitting: currentTransmitting() };
    const previous = gate;
    gate = evaluateGate(inputs, gateSettings());
    const changed = !previous || JSON.stringify(previous) !== JSON.stringify(gate);

    // Feeding follows the gate immediately — muting stops recognition this instant, even
    // though the mic itself closes after the debounce.
    setFeeding(gate.feeding && !!capture);

    const shouldCapture = gate.captureOpen && engineUsable();
    if (shouldCapture !== wantCapture) {
        wantCapture = shouldCapture;
        if (captureTimer) clearTimeout(captureTimer);
        captureTimer = setTimeout(() => {
            captureTimer = null;
            void syncCapture();
        }, GATE_DEBOUNCE_MS);
    }

    // this runs on every voice-state change in every server; only re-render on a real change
    if (changed) setStatus({ gate });
}

function setFeeding(next: boolean) {
    if (next === feeding) return;
    feeding = next;

    if (next) {
        // hand over the pre-roll so the start of the first word is not lost to VAD latency
        if (engine?.consumesFrames) for (const frame of preroll) engine.acceptFrame(frame);
    } else {
        feedingEndedAt = performance.now();
        engine?.endUtterance();
    }
    preroll.length = 0;
}

function onSpeaking(speaking: boolean) {
    speakingSeen = true;
    loudFramesWithoutSpeaking = 0;
    if (getStatus().warning) setStatus({ warning: null });

    if (speaking === transmittingDiscord) return;
    transmittingDiscord = speaking;
    if (settings.store.transmitSource === "discord") reevaluateGate();
}

// #endregion

// #region capture

async function syncCapture(): Promise<void> {
    if (!running || captureBusy) return;

    if (!wantCapture) {
        closeCapture();
        return;
    }
    if (capture) return;

    captureBusy = true;
    setStatus({ captureState: "opening" });

    try {
        const ready = await ensureEngine();
        if (!ready || !running || !wantCapture) return;

        const device = await resolveWebDevice("audioinput", getDiscordInputDevice(), settings.store.inputDeviceId);
        const opened = await Capture.open(device, {
            onFrame: safely("onFrame", onFrame),
            onEnded: safely("onEnded", onCaptureEnded)
        });

        if (!running || !wantCapture) {
            opened.close();
            return;
        }

        capture = opened;
        speakingSeen = false;
        loudFramesWithoutSpeaking = 0;
        ready.attach(opened.track);
        reactionPlayer.warm();

        setStatus({
            captureState: "open",
            captureDevice: opened.deviceLabel,
            captureMode: opened.mode,
            outputDevice: reactionPlayer.output,
            banner: getStatus().banner?.action === "enableListening" ? null : getStatus().banner
        });
        // the output device resolves asynchronously; show it once known
        setTimeout(() => running && setStatus({ outputDevice: reactionPlayer.output }), 500);
    } catch (e) {
        handleCaptureFailure(e);
    } finally {
        captureBusy = false;
        if (getStatus().captureState === "opening") setStatus({ captureState: capture ? "open" : "closed" });
        reevaluateGate();
        // the gate may have flipped while we were busy
        if (running && wantCapture !== !!capture && !captureTimer) void syncCapture();
    }
}

function handleCaptureFailure(e: unknown) {
    if (e instanceof CaptureError) {
        // §10.3: disable listening rather than retrying into the same refusal, and say why
        settings.store.listening = false;
        showToast(`MouthWash: ${e.message}`, "failure");
        setStatus({
            captureState: "error",
            banner: { message: `Listening was switched off: ${e.message}`, action: "enableListening" }
        });
        wantCapture = false;
        return;
    }

    logger.error("Could not open capture", e);
    setStatus({ captureState: "error", banner: { message: `Could not start listening: ${errorText(e)}` } });
}

function closeCapture() {
    if (!capture) return;

    try {
        engine?.detach();
    } catch { }

    capture.close();
    capture = null;
    reactionPlayer.release();

    setFeeding(false);
    preroll.length = 0;
    levelGate.reset();
    transmittingLevel = false;
    setLevel(0);
    setStatus({ captureState: "closed", captureDevice: null, captureMode: null });
}

function onCaptureEnded(reason: string) {
    logOnce(`ended:${reason}`, reason);
    closeCapture();
    // try again (e.g. Discord's device is back, or the default mic changed) after the debounce
    wantCapture = false;
    reevaluateGate();
}

function onFrame(samples: Float32Array, rms: number) {
    if (!running || !capture) return;
    setLevel(rms);

    const s = settings.store;
    if (s.transmitSource === "level") {
        const t = levelGate.update(rms, s.rmsThreshold, performance.now());
        if (t !== transmittingLevel) {
            transmittingLevel = t;
            reevaluateGate();
        }
    } else if (s.requireTransmitting && !speakingSeen && rms > SPEAKING_SUSPICION_RMS) {
        // §10.3: an expected event that never fires must fail closed — which it does, since
        // "transmitting" stays false — and be reported, not silently ignored
        if (++loudFramesWithoutSpeaking === SPEAKING_SUSPICION_FRAMES) {
            logOnce("no-speaking", "Heard sustained speech but Discord never reported you speaking; the SPEAKING event may have changed");
            setStatus({
                warning: "MouthWash hears you, but Discord hasn't reported you transmitting. If you are talking in the call, Discord may have changed its speaking event — switch \"Transmit detection\" to \"Input level\" under Advanced as a workaround."
            });
        }
    }

    if (feeding) {
        engine?.acceptFrame(samples);
    } else if (engine?.consumesFrames && (s.transmitSource === "level" || !isPushToTalk())) {
        // overwritten continuously, never processed unless transmission starts (§12)
        preroll.push(samples);
        if (preroll.length > PREROLL_FRAMES) preroll.shift();
    }
}

// #endregion

// #region engine

function engineCallbacks(generation: number): EngineCallbacks {
    const live = () => running && generation === engineGeneration;
    return {
        onPartial: safely("onPartial", (text: string) => {
            if (live() && resultsAllowed()) handleEvents(detector.onPartial(text));
        }),
        onFinal: safely("onFinal", (result: FinalResult) => {
            if (!live()) return;
            if (resultsAllowed()) handleEvents(detector.onFinal(result));
            // speech from outside a transmission: not ours to judge, just start fresh
            else detector.reset();
        }),
        onCrash: safely("onCrash", (message: string) => {
            if (live()) onEngineCrash(message);
        })
    };
}

/** Vosk only ever hears transmitted audio. Web Speech hears everything, so filter by time. */
function resultsAllowed(): boolean {
    if (!engine || engine.consumesFrames) return true;
    return feeding || performance.now() - feedingEndedAt < WEBSPEECH_TAIL_MS;
}

async function ensureEngine(): Promise<RecognitionEngine | null> {
    if (engine) return engine;
    if (engineLoading) return engineLoading;
    if (!resolution?.kind || engineFailed) return null;

    const generation = engineGeneration;
    const { kind } = resolution;

    engineLoading = (async () => {
        try {
            let created: RecognitionEngine;
            if (kind === "webspeech") {
                created = new WebSpeechEngine(engineCallbacks(generation));
            } else {
                setStatus({ engineState: "loading", engineDetail: "Verifying and loading the speech model…" });
                created = await VoskEngine.create(settings.store.modelId, engineCallbacks(generation));
            }

            if (!running || generation !== engineGeneration) {
                created.dispose();
                return null;
            }

            engine = created;
            setStatus({ engineState: "ready", engineLabel: created.label, engineDetail: resolution?.reason ?? null });
            await applyWords();
            return created;
        } catch (e) {
            if (generation !== engineGeneration) return null;
            onEngineLoadFailure(e);
            return null;
        } finally {
            if (generation === engineGeneration) engineLoading = null;
        }
    })();

    return engineLoading;
}

function onEngineLoadFailure(e: unknown) {
    if (e instanceof ModelMissingError) {
        setStatus({ engineState: "needsModel", engineDetail: "The speech model needs to be downloaded first." });
    } else if (e instanceof HashMismatchError) {
        // §10.3: never load an unverified model
        engineFailed = true;
        setStatus({
            engineState: "error",
            engineDetail: e.message,
            banner: { message: `The cached speech model failed verification and was not loaded. ${e.message}`, action: "downloadModel" }
        });
    } else {
        logger.error("Engine failed to load", e);
        engineFailed = true;
        setStatus({ engineState: "error", engineDetail: errorText(e), banner: { message: `The speech engine failed to load: ${errorText(e)}`, action: "retryEngine" } });
    }
    reevaluateGate();
}

function onEngineCrash(message: string) {
    logger.error(message);
    closeCapture();
    disposeEngine();

    // §10.3: restart once with backoff; on repeat failure, disable and report
    if (crashRestarts < 1) {
        crashRestarts++;
        setStatus({ engineState: "standby", engineDetail: `${message} Restarting…` });
        setTimeout(() => {
            if (!running) return;
            wantCapture = false;
            reevaluateGate();
        }, CRASH_BACKOFF_MS);
        return;
    }

    engineFailed = true;
    setStatus({ engineState: "error", engineDetail: message, banner: { message: `The speech engine stopped: ${message}`, action: "retryEngine" } });
    reevaluateGate();
}

export function retryEngine(): void {
    reloadEngine();
}

// #endregion

// #region words & detection

/** Call after any change to the word list. Debounced; rebuilds the grammar only if needed. */
export function onWordsChanged(): void {
    if (wordsTimer) clearTimeout(wordsTimer);
    wordsTimer = setTimeout(() => {
        wordsTimer = null;
        void applyWords().catch(e => logger.error("Updating words failed", e));
    }, WORDS_DEBOUNCE_MS);
}

async function applyWords(): Promise<void> {
    // a word the user re-enabled gets a fresh check rather than staying refused
    const rejectedBefore = { ...getStatus().rejected };
    const candidates = (settings.store.words ?? []).filter(w => w.enabled && !phraseError(w.phrase));
    for (const w of candidates) delete rejectedBefore[w.id];

    detector.setWords(candidates.filter(w => !rejectedBefore[w.id]));
    if (!engine) {
        setStatus({ rejected: rejectedBefore });
        return;
    }

    const phrases = [...new Set(candidates.map(w => w.phrase))];
    const variants = [...new Set(candidates.flatMap(w => phraseVariants(w.phrase, w.matchPlurals !== false)))];
    const update = await engine.setPhrases(phrases, settings.store.useRestrictedGrammar, variants);

    const rejected = { ...rejectedBefore };
    const newlyRejected: string[] = [];
    for (const { phrase, reason } of update.rejected) {
        for (const w of candidates.filter(c => c.phrase === phrase)) {
            rejected[w.id] = reason;
            // §6.4: disable only the offending word, and say which one
            w.enabled = false;
            newlyRejected.push(`"${phrase}" (${reason})`);
        }
    }

    setStatus({ rejected });
    detector.setWords(activeWords());

    if (newlyRejected.length) {
        showToast(`MouthWash disabled ${newlyRejected.join(", ")}`, "failure");
    }
}

function handleEvents(events: DetectionEvent[]) {
    if (!events.length) return;

    const words = settings.store.words ?? [];
    const now = performance.now();

    for (const event of events) {
        const word = words.find(w => w.id === event.wordId);
        if (!word) continue;

        switch (event.type) {
            case "hit": {
                // React first: the reaction is the whole point, and nothing after it (stats,
                // saving the count) may be able to stop it from playing.
                const fired = cooldowns.tryFire(word.id, word.cooldownMs, settings.store.globalCooldownMs, now);
                if (fired) {
                    void reactionPlayer.play(effectiveReaction(word, settings.store.defaultReaction), word.phrase, { audible: !isDeafened() })
                        .catch(e => logger.error("Reaction failed", e));
                }

                // hits a cooldown swallows still count (§10.2); deafened hits count too (§10.1)
                recordHit(word.id, word.phrase, fired);
                try {
                    word.hitCount = (word.hitCount ?? 0) + 1;
                } catch (e) {
                    logOnce("hit-count", "Could not save a word's hit count", e);
                }
                break;
            }
            case "confirmed":
                recordConfirmed(word.id);
                break;
            case "suspectedFalsePositive":
                recordSuspected(word.id, event.confidence);
                break;
        }
    }
}

// #endregion

// #region user actions

export function setListening(on: boolean): void {
    settings.store.listening = on;
    if (on && getStatus().banner?.action === "enableListening") setStatus({ banner: null, captureState: "closed" });
    reevaluateGate();
}

export function toggleListening(): void {
    const next = !settings.store.listening;
    setListening(next);
    showToast(next ? "MouthWash is listening" : "MouthWash stopped listening", "message");
}

/** The explicit, user-confirmed one-time download (§8.5). */
export async function downloadModel(): Promise<void> {
    if (download || !running) return;
    const controller = new AbortController();
    download = controller;

    setStatus({ engineState: "downloading", downloadProgress: 0, downloadPhase: "Starting…", banner: null });

    try {
        await downloadBundle(settings.store.modelId, p => {
            if (download === controller) setStatus({ downloadProgress: p.fraction, downloadPhase: p.phase });
        }, controller.signal);

        if (download !== controller) return;
        setStatus({ downloadProgress: null, downloadPhase: null });
        showToast("MouthWash: speech model downloaded and verified", "success");
        reloadEngine();
    } catch (e) {
        if (download !== controller) return;
        const cancelled = controller.signal.aborted;
        setStatus({
            engineState: "needsModel",
            downloadProgress: null,
            downloadPhase: null,
            banner: cancelled ? null : { message: `Model download failed: ${errorText(e)}`, action: "downloadModel" }
        });
        if (!cancelled) logger.error("Model download failed", e);
    } finally {
        if (download === controller) download = null;
    }
}

export function cancelDownload(): void {
    download?.abort();
}

export async function testReaction(reaction: ReactionConfig, phrase: string): Promise<void> {
    await reactionPlayer.play(reaction, phrase || "test", { audible: true });
}

export const isRunning = () => running;

// #endregion
