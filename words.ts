/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Pure construction and normalisation of target words and reactions. No Vencord/webpack/DOM
 * imports, so the JSON escape hatch and settings migration can be unit-tested (words.test.ts).
 */

import { normalizePhrase, phraseError } from "./detection";
import type { PresetSoundId, ReactionConfig, ReactionKind, TargetWord } from "./types";

export const REACTION_KINDS: ReactionKind[] = ["buzzer", "preset", "beep", "customSound", "toast", "tts", "silent"];

/** Mirrors PresetSoundId; listed here so this module stays free of the bundled-asset imports. */
export const PRESET_IDS: PresetSoundId[] = ["incorrectBuzzer", "legoHey"];

/** Ships conservative (§2): a word has to be heard fairly clearly before it counts. */
export const DEFAULT_THRESHOLD = 0.75;
export const DEFAULT_WORD_COOLDOWN_MS = 3000;
export const DEFAULT_GLOBAL_COOLDOWN_MS = 1500;
export const MAX_COOLDOWN_MS = 60_000;

export const DEFAULT_REACTION: Readonly<ReactionConfig> = Object.freeze({
    kind: "buzzer",
    volume: 0.5,
    alsoToast: false
});

export const clamp = (n: unknown, min: number, max: number, fallback: number): number =>
    typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

export function normalizeReactionInPlace(reaction: any): ReactionConfig {
    if (!REACTION_KINDS.includes(reaction.kind)) reaction.kind = DEFAULT_REACTION.kind;
    reaction.volume = clamp(reaction.volume, 0, 1, DEFAULT_REACTION.volume);
    reaction.alsoToast = !!reaction.alsoToast;

    if (!PRESET_IDS.includes(reaction.preset)) {
        if (reaction.kind === "preset") reaction.preset = PRESET_IDS[0];
        else delete reaction.preset;
    }
    if (typeof reaction.soundPath !== "string") delete reaction.soundPath;
    if (typeof reaction.ttsText !== "string") delete reaction.ttsText;

    return reaction;
}

export const makeReaction = (overrides: Partial<ReactionConfig> = {}): ReactionConfig =>
    normalizeReactionInPlace({ ...DEFAULT_REACTION, ...overrides });

/**
 * Fill in and repair a word in place. A phrase that fails validation is kept as typed (so the
 * user can see and fix it) but the word is disabled, so it never reaches a grammar.
 */
export function normalizeWordInPlace(word: any, newId: () => string): TargetWord {
    if (typeof word.id !== "string" || !word.id) word.id = newId();
    word.phrase = normalizePhrase(word.phrase ?? "");
    word.threshold = clamp(word.threshold, 0, 1, DEFAULT_THRESHOLD);
    word.cooldownMs = Math.round(clamp(word.cooldownMs, 0, MAX_COOLDOWN_MS, DEFAULT_WORD_COOLDOWN_MS));
    // on unless explicitly turned off, so words saved before this option existed get it too
    word.matchPlurals = word.matchPlurals !== false;
    word.hitCount = Math.max(0, Math.floor(clamp(word.hitCount, 0, Number.MAX_SAFE_INTEGER, 0)));
    word.enabled = word.enabled !== false && !phraseError(word.phrase);

    word.reaction = word.reaction && typeof word.reaction === "object"
        ? normalizeReactionInPlace(word.reaction)
        : null;

    return word;
}

export const makeWord = (phrase: string, newId: () => string): TargetWord => normalizeWordInPlace({
    id: newId(),
    phrase,
    threshold: DEFAULT_THRESHOLD,
    reaction: null,
    cooldownMs: DEFAULT_WORD_COOLDOWN_MS,
    matchPlurals: true,
    enabled: true,
    hitCount: 0
}, newId);

/** Normalise a whole word list: repair each word and drop duplicate ids and phrases. */
export function normalizeWordList(words: unknown, newId: () => string): TargetWord[] {
    if (!Array.isArray(words)) return [];

    const ids = new Set<string>();
    const phrases = new Set<string>();
    const out: TargetWord[] = [];

    for (const raw of words) {
        if (!raw || typeof raw !== "object") continue;

        const word = normalizeWordInPlace(raw, newId);
        if (ids.has(word.id)) word.id = newId();
        if (word.phrase && phrases.has(word.phrase)) continue;

        ids.add(word.id);
        if (word.phrase) phrases.add(word.phrase);
        out.push(word);
    }

    return out;
}

export const effectiveReaction = (word: TargetWord, fallback: ReactionConfig): ReactionConfig => word.reaction ?? fallback;

/**
 * Candidate words from VariableFilter's rules (§5.4): literal, non-regex phrase rules only,
 * normalised, valid, and not already on the list. Takes the raw rules value so it never throws
 * on whatever shape another plugin's settings happen to be in.
 */
export function phrasesFromVariableFilter(rules: unknown, existing: string[]): string[] {
    if (!Array.isArray(rules)) return [];

    const have = new Set(existing);
    const out: string[] = [];

    for (const rule of rules) {
        if (!rule || typeof rule !== "object") continue;
        if ((rule as any).matchKind !== "phrase" || (rule as any).isRegex) continue;

        const phrase = normalizePhrase((rule as any).pattern ?? "");
        if (phraseError(phrase) || have.has(phrase)) continue;

        have.add(phrase);
        out.push(phrase);
    }

    return out;
}
