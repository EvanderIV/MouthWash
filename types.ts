/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * `buzzer` is the procedural default (§10.1). `preset` plays one of the clips bundled in
 * ./assets (see presetSounds.ts) — an addition to the spec's list.
 */
export type ReactionKind = "buzzer" | "preset" | "beep" | "customSound" | "toast" | "tts" | "silent";

/** Clips bundled in ./assets. Keep in sync with presetSounds.ts. */
export type PresetSoundId = "incorrectBuzzer" | "legoHey";

export interface ReactionConfig {
    kind: ReactionKind;
    /** 0..1 output gain for sound reactions */
    volume: number;
    /** for kind === "preset": which bundled clip */
    preset?: PresetSoundId;
    /** for kind === "customSound": a file path chosen by the user (read via native, §8.4) */
    soundPath?: string;
    /** for kind === "tts": what to say, e.g. "you said like" */
    ttsText?: string;
    /** also show a toast naming the word, regardless of kind */
    alsoToast: boolean;
}

export interface TargetWord {
    /** stable uuid */
    id: string;
    /** the word or short phrase to listen for, lowercase, as spoken */
    phrase: string;
    /**
     * 0..1 — minimum recognizer confidence required to count as a hit.
     * Higher = fewer false positives, more misses. At FINAL_ONLY_THRESHOLD and above the word
     * stops firing on partial results entirely (§6.5).
     */
    threshold: number;
    /** per-word reaction override; falls back to the global reaction when null */
    reaction: ReactionConfig | null;
    /** milliseconds to ignore repeat hits of THIS word after it fires */
    cooldownMs: number;
    /** also catch plural forms of the last word ("fuck" → "fucks"); see detection.pluralForms */
    matchPlurals: boolean;
    enabled: boolean;
    /** rolling count, local only, resettable — powers the stats panel (§9) */
    hitCount: number;
}

export type EngineChoice = "auto" | "webspeech" | "vosk";
export type EngineKind = "webspeech" | "vosk";

/**
 * Where "am I transmitting right now" comes from (§7.1).
 *
 * - `discord` — the SPEAKING flux event for the current user, i.e. Discord's own PTT/VAD decision.
 * - `level`   — RMS of MouthWash's own capture against `rmsThreshold`. A debugging fallback: it
 *               duplicates Discord's VAD and will disagree with it.
 */
export type TransmitSource = "discord" | "level";

/** One word as the recognizer sees it in a final result. */
export interface RecognizedWord {
    word: string;
    /** 0..1, or null when the engine does not report a per-word confidence */
    conf: number | null;
    /** seconds into the utterance's audio, when the engine reports it (Vosk does) */
    start?: number;
    end?: number;
}

export interface FinalResult {
    text: string;
    words: RecognizedWord[];
}
