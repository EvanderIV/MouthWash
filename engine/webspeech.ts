/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * On-device Web Speech backend (§6.1).
 *
 * Critical: Chromium's classic SpeechRecognition streams audio to Google. That must never
 * happen, so this backend is only used when on-device recognition can be both *confirmed* and
 * *enforced*:
 *
 *  - availability must come from an on-device query — `SpeechRecognition.available({ langs,
 *    processLocally: true })` (current Chromium) or `availableOnDevice(lang)` (the earlier
 *    shape of the same API) — and must report "available";
 *  - every recognizer instance must accept being pinned on-device (`processLocally = true`, or
 *    `mode = "ondevice-only"` on the earlier shape) and read the setting back.
 *
 * If either check fails, Web Speech is treated as unavailable, full stop. A "network" or
 * "service-not-allowed" error at runtime — which would mean something tried to go off-device —
 * kills the engine permanently rather than retrying.
 */

import { logOnce } from "../fluxEvents";
import type { FinalResult } from "../types";
import type { EngineCallbacks, PhraseUpdate, RecognitionEngine } from ".";

const LANG = "en-US";
/** restart budget, so a recognizer that keeps ending cannot spin */
const MAX_RESTARTS_PER_MINUTE = 20;

const getSR = (): any => (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

/** Pin a recognizer instance on-device. Returns false if it cannot be pinned. */
function pinOnDevice(rec: any): boolean {
    try {
        if ("processLocally" in rec) {
            rec.processLocally = true;
            return rec.processLocally === true;
        }
        if ("mode" in rec) {
            rec.mode = "ondevice-only";
            return rec.mode === "ondevice-only";
        }
    } catch { }
    return false;
}

export async function probeWebSpeech(): Promise<{ ok: true; } | { ok: false; reason: string; }> {
    // Electron (Vesktop, Discord desktop) exposes SpeechRecognition.available() to the page, but
    // its browser process has no binder for media.mojom.OnDeviceSpeechRecognition. The first call
    // gets the whole Discord renderer killed for a "bad Mojo message" — a process kill, not an
    // exception, so no try/catch can contain it, and every reload crashes again (a blank window).
    // Only a real Chromium browser (Vencord web) implements the service, so desktop builds must
    // not touch the API at all.
    if (!IS_WEB) return { ok: false, reason: "isn't supported by desktop Discord clients" };

    try {
        const SR = getSR();
        if (!SR) return { ok: false, reason: "is not present" };

        let state: unknown;
        if (typeof SR.available === "function") {
            state = await SR.available({ langs: [LANG], processLocally: true });
        } else if (typeof SR.availableOnDevice === "function") {
            state = await SR.availableOnDevice(LANG);
        } else {
            return { ok: false, reason: "has no on-device mode in this client" };
        }

        if (state !== "available") return { ok: false, reason: `on-device model is "${String(state)}"` };
        if (!pinOnDevice(new SR())) return { ok: false, reason: "cannot be pinned on-device" };

        return { ok: true };
    } catch (e) {
        return { ok: false, reason: `probe failed (${(e as any)?.message ?? e})` };
    }
}

export class WebSpeechEngine implements RecognitionEngine {
    readonly kind = "webspeech" as const;
    readonly label = "On-device Web Speech";
    readonly consumesFrames = false;

    private rec: any = null;
    private track: MediaStreamTrack | null = null;
    private running = false;
    private dead = false;
    private phrases: string[] = [];
    private restarts: number[] = [];

    constructor(private readonly callbacks: EngineCallbacks) { }

    async setPhrases(phrases: string[]): Promise<PhraseUpdate> {
        // Web Speech has no restricted grammar; phrases are only a biasing hint where supported
        this.phrases = phrases;
        if (this.running) this.restart();
        return { accepted: phrases, rejected: [] };
    }

    attach(track: MediaStreamTrack | null): void {
        this.track = track;
        this.running = true;
        this.startRecognizer();
    }

    detach(): void {
        this.running = false;
        this.stopRecognizer();
    }

    acceptFrame(): void { }

    endUtterance(): void { }

    dispose(): void {
        this.detach();
        this.track = null;
    }

    private restart() {
        this.stopRecognizer();
        this.startRecognizer();
    }

    private stopRecognizer() {
        const { rec } = this;
        this.rec = null;
        if (!rec) return;
        rec.onresult = rec.onerror = rec.onend = null;
        try {
            rec.abort();
        } catch { }
    }

    private fail(message: string) {
        this.dead = true;
        this.running = false;
        this.stopRecognizer();
        this.callbacks.onCrash(message);
    }

    private startRecognizer() {
        if (this.dead || !this.running || this.rec) return;

        const now = Date.now();
        this.restarts = this.restarts.filter(t => now - t < 60_000);
        if (this.restarts.length >= MAX_RESTARTS_PER_MINUTE) {
            this.fail("On-device speech recognition keeps stopping.");
            return;
        }
        this.restarts.push(now);

        const SR = getSR();
        const rec = new SR();

        // never start a recognizer that might be using the cloud service
        if (!pinOnDevice(rec)) {
            this.fail("Speech recognition could not be pinned to on-device processing, so it was not started.");
            return;
        }

        rec.lang = LANG;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        const Phrase = (window as any).SpeechRecognitionPhrase;
        if (this.phrases.length && "phrases" in rec && typeof Phrase === "function") {
            try {
                rec.phrases = this.phrases.map(p => new Phrase(p, 5));
            } catch (e) {
                logOnce("ws-phrases", "Web Speech phrase biasing is unavailable", e);
            }
        }

        rec.onresult = (e: any) => {
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const result = e.results[i];
                const alt = result[0];
                if (!alt) continue;

                if (result.isFinal) {
                    // on-device recognizers often report 0 for "unknown"; treat that as unknown
                    const conf = typeof alt.confidence === "number" && alt.confidence > 0 ? alt.confidence : null;
                    const final: FinalResult = {
                        text: alt.transcript,
                        words: String(alt.transcript).split(/\s+/).filter(Boolean).map(word => ({ word, conf }))
                    };
                    this.callbacks.onFinal(final);
                } else {
                    interim += `${alt.transcript} `;
                }
            }
            if (interim) this.callbacks.onPartial(interim);
        };

        rec.onerror = (e: any) => {
            switch (e?.error) {
                case "no-speech":
                case "aborted":
                    return;
                case "network":
                case "service-not-allowed":
                    // would mean an attempt to reach a server — never retry
                    this.fail("Speech recognition tried to use the network; it has been switched off.");
                    return;
                case "language-not-supported":
                case "not-allowed":
                    this.fail(`On-device speech recognition failed: ${e.error}.`);
                    return;
                default:
                    logOnce(`ws-error:${e?.error}`, `Web Speech error: ${e?.error}`);
            }
        };

        rec.onend = () => {
            if (this.rec !== rec) return;
            this.rec = null;
            // continuous recognition still ends on long silences; pick it back up
            if (this.running) setTimeout(() => this.startRecognizer(), 250);
        };

        this.rec = rec;
        try {
            // start(track) listens to MouthWash's own capture of Discord's input device;
            // clients without that overload ignore the argument and use the default mic
            rec.start(this.track ?? undefined);
        } catch {
            try {
                rec.start();
            } catch (e) {
                this.rec = null;
                this.fail(`On-device speech recognition could not start: ${(e as any)?.message ?? e}`);
            }
        }
    }
}
