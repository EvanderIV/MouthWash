/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Engine selection (§6.1) and the interface both backends implement.
 *
 * `auto` resolves, in order: on-device Web Speech (only if it can be *proven* on-device), then
 * Vosk WASM, then nothing. Cloud Web Speech is never an option — see webspeech.ts.
 */

import type { EngineChoice, EngineKind, FinalResult } from "../types";
import { probeWebSpeech } from "./webspeech";

export interface EngineCallbacks {
    onPartial(text: string): void;
    onFinal(result: FinalResult): void;
    /** the engine died (e.g. its worker crashed); the controller may restart it once */
    onCrash(message: string): void;
}

export interface PhraseUpdate {
    accepted: string[];
    rejected: { phrase: string; reason: string; }[];
}

export interface RecognitionEngine {
    readonly kind: EngineKind;
    readonly label: string;
    /**
     * true: the engine only hears the frames it is handed, so the transmit gate is enforced by
     * not feeding it. false: it listens to the capture track itself (Web Speech), so the
     * controller drops results that arrive while not transmitting.
     */
    readonly consumesFrames: boolean;

    /** Rebuild the grammar/biasing for this phrase set (§6.3). Never throws for a bad phrase. */
    /**
     * `variants` are extra forms (e.g. plurals) a restricted grammar must also be able to output.
     * They are optional: one the model doesn't know is dropped silently, never reported as a
     * rejected phrase.
     */
    setPhrases(phrases: string[], restrictedGrammar: boolean, variants?: string[]): Promise<PhraseUpdate>;
    /** the mic opened */
    attach(track: MediaStreamTrack | null): void;
    /** the mic closed; the model stays loaded */
    detach(): void;
    /** 16 kHz mono float samples, only ever while transmitting */
    acceptFrame(samples: Float32Array): void;
    /** transmission stopped — finish the utterance so its final result arrives */
    endUtterance(): void;
    /** free everything: worker, model, recognizer */
    dispose(): void;
}

export interface EngineResolution {
    kind: EngineKind | null;
    /** why this engine (or why none) */
    reason: string;
    /** what the on-device Web Speech probe found, for the status panel */
    webSpeech: string;
}

function voskUnsupportedReason(): string | null {
    if (typeof WebAssembly !== "object") return "WebAssembly is unavailable";
    if (typeof Worker !== "function") return "Web Workers are unavailable";
    if (typeof DecompressionStream !== "function") return "DecompressionStream is unavailable";
    if (!crypto?.subtle) return "SubtleCrypto (needed to verify the model) is unavailable";
    return null;
}

export async function resolveEngine(choice: EngineChoice): Promise<EngineResolution> {
    const ws = await probeWebSpeech();
    const webSpeech = ws.ok ? "available on-device" : ws.reason;

    if (choice !== "vosk" && ws.ok) {
        return { kind: "webspeech", reason: "On-device speech recognition is available in this client.", webSpeech };
    }

    if (choice === "webspeech") {
        return { kind: null, reason: `On-device Web Speech was selected but ${webSpeech}.`, webSpeech };
    }

    const voskProblem = voskUnsupportedReason();
    if (voskProblem) {
        return { kind: null, reason: `No usable speech engine: Web Speech ${webSpeech}, and Vosk needs ${voskProblem.replace(/ is unavailable$/, "")}.`, webSpeech };
    }

    return {
        kind: "vosk",
        reason: choice === "vosk" ? "Vosk selected in Advanced settings." : `Using Vosk because on-device Web Speech ${webSpeech}.`,
        webSpeech
    };
}
