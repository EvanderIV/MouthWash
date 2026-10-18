/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Pure hit detection: recognizer hypotheses + word list + thresholds → hits (§6.5).
 *
 * Deliberately free of Vencord/webpack/DOM imports so it can be unit-tested against fixed
 * hypotheses (see detection.test.ts). No transcript is retained: every method matches the text
 * it is handed and keeps only per-word counts for the current utterance.
 */

import type { FinalResult } from "./types";

/** What a phrase may contain (§5.1). Vosk grammars are whitespace-tokenised. */
export const PHRASE_PATTERN = /^[a-z0-9]+( [a-z0-9]+)*$/;

/** At or above this threshold a word only fires on final results, never on partials (§6.5 rule 3). */
export const FINAL_ONLY_THRESHOLD = 0.95;

export const isFinalOnly = (threshold: number) => threshold >= FINAL_ONLY_THRESHOLD;

/** Lowercase, trim and collapse whitespace — what the UI applies before validating. */
export function normalizePhrase(raw: string): string {
    return String(raw ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Why a phrase is unusable, or null when it is fine. */
export function phraseError(phrase: string): string | null {
    if (!phrase) return "Enter a word to listen for.";
    if (!PHRASE_PATTERN.test(phrase)) {
        return "Only lowercase letters a–z, digits and single spaces — no punctuation or apostrophes.";
    }
    return null;
}

/**
 * Split recognizer output into comparable tokens.
 *
 * Apostrophes are dropped rather than split on, so "don't" becomes "dont" and can never match a
 * phrase "don". `[unk]` survives as its own token, so a phrase never matches across Vosk's
 * garbage bucket. `*` survives so profanity-masked output ("f***") can still be recognised.
 */
export function tokenize(text: string): string[] {
    return String(text ?? "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9*[\]]+/g, " ")
        .split(" ")
        .filter(Boolean);
}

const MASKED = /^[a-z0-9]\*+$/;

/**
 * Whether one recognized token is the given phrase word. Besides exact equality, accepts a
 * masked token ("f***") with the same first letter and length — some recognizers censor
 * profanity, and the words this plugin exists for are exactly the ones that get censored.
 */
export function tokenMatches(token: string, word: string): boolean {
    if (token === word) return true;
    return MASKED.test(token) && token.length === word.length && token[0] === word[0];
}

/**
 * Regular English plural (and third-person "-s") forms of one word, not including the word
 * itself: "fuck" → fucks, "bitch" → bitches, "pussy" → pussies, "knife" → knives.
 *
 * Deliberately only the -s family. "-ing"/"-ed" forms ("fucking", "fucked") are different words
 * that a user may or may not want caught, so they stay explicit entries in the word list.
 * Irregular plurals are not attempted. Possessives are covered for free: tokenize() drops the
 * apostrophe, so "shit's" arrives as "shits".
 */
export function pluralForms(word: string): string[] {
    if (!/^[a-z]{2,}$/.test(word)) return [];

    const forms = new Set<string>([`${word}s`]);
    if (/(s|x|z|ch|sh)$/.test(word)) forms.add(`${word}es`);
    if (/[^aeiou]y$/.test(word)) forms.add(`${word.slice(0, -1)}ies`);
    if (/[^aeiou]o$/.test(word)) forms.add(`${word}es`);
    if (/[^f]fe$/.test(word)) forms.add(`${word.slice(0, -2)}ves`);
    else if (/[^f]f$/.test(word)) forms.add(`${word.slice(0, -1)}ves`);

    forms.delete(word);
    return [...forms];
}

/** One position of a compiled phrase: the word, or any of several accepted forms. */
export type PhraseSlot = string | readonly string[];

const slotMatches = (token: string, slot: PhraseSlot) =>
    typeof slot === "string" ? tokenMatches(token, slot) : slot.some(form => tokenMatches(token, form));

/** A phrase's tokens, with the last word widened to its plural forms when asked. */
export function compilePhrase(phrase: string, matchPlurals: boolean): PhraseSlot[] {
    const tokens: PhraseSlot[] = tokenize(phrase);
    if (matchPlurals && tokens.length) {
        const last = tokens[tokens.length - 1] as string;
        const plurals = pluralForms(last);
        if (plurals.length) tokens[tokens.length - 1] = [last, ...plurals];
    }
    return tokens;
}

/**
 * Every whole phrase a word stands for, e.g. "oh my god" → ["oh my god", "oh my gods"].
 * Used to widen a restricted grammar, which can only output phrases it was given.
 */
export function phraseVariants(phrase: string, matchPlurals: boolean): string[] {
    const slots = compilePhrase(phrase, matchPlurals);
    const last = slots.at(-1);
    if (!Array.isArray(last)) return [phrase];
    const head = slots.slice(0, -1).join(" ");
    return (last as string[]).map(form => head ? `${head} ${form}` : form);
}

/** Start indices of non-overlapping occurrences of `phrase` in `tokens`, left to right. */
export function findOccurrences(tokens: string[], phrase: readonly PhraseSlot[]): number[] {
    const found: number[] = [];
    if (!phrase.length) return found;

    for (let i = 0; i + phrase.length <= tokens.length;) {
        let ok = true;
        for (let j = 0; j < phrase.length; j++) {
            if (!slotMatches(tokens[i + j], phrase[j])) {
                ok = false;
                break;
            }
        }

        if (ok) {
            found.push(i);
            i += phrase.length;
        } else {
            i++;
        }
    }

    return found;
}

export interface DetectorWord {
    id: string;
    phrase: string;
    threshold: number;
    /** also catch plural forms of the phrase's last word; defaults to true */
    matchPlurals?: boolean;
}

export type DetectionEvent =
    /** fire the reaction (subject to cooldowns) */
    | { type: "hit"; wordId: string; source: "partial" | "final"; confidence: number | null; }
    /** a partial hit that the final result backed up */
    | { type: "confirmed"; wordId: string; confidence: number | null; }
    /**
     * a partial hit the final result did not back up — the word is absent (confidence null) or
     * scored under the threshold. The buzzer already fired and cannot be un-rung; this exists
     * so the user can see it and raise the threshold.
     */
    | { type: "suspectedFalsePositive"; wordId: string; confidence: number | null; };

interface CompiledWord {
    id: string;
    tokens: PhraseSlot[];
    threshold: number;
}

/**
 * Turns a stream of partial and final hypotheses into hit events.
 *
 * Vosk partials are cumulative within an utterance ("fuck" → "fuck [unk]" → "fuck [unk] fuck"),
 * so a word is only reported again when its occurrence count in the partial goes *up*. The
 * per-utterance counts reset on every final result.
 */
export class HitDetector {
    private words: CompiledWord[] = [];
    /** wordId → occurrences already fired from partials in the current utterance */
    private firedOnPartial = new Map<string, number>();

    constructor(words: DetectorWord[] = []) {
        this.setWords(words);
    }

    setWords(words: DetectorWord[]): void {
        this.words = words
            .map(w => ({ id: w.id, tokens: compilePhrase(w.phrase, w.matchPlurals !== false), threshold: w.threshold }))
            .filter(w => w.tokens.length);
        this.firedOnPartial.clear();
    }

    reset(): void {
        this.firedOnPartial.clear();
    }

    onPartial(text: string): DetectionEvent[] {
        const tokens = tokenize(text);
        const events: DetectionEvent[] = [];

        for (const word of this.words) {
            if (isFinalOnly(word.threshold)) continue;

            const count = findOccurrences(tokens, word.tokens).length;
            const seen = this.firedOnPartial.get(word.id) ?? 0;

            for (let k = seen; k < count; k++) {
                events.push({ type: "hit", wordId: word.id, source: "partial", confidence: null });
            }

            if (count > seen) this.firedOnPartial.set(word.id, count);
        }

        return events;
    }

    onFinal(result: FinalResult): DetectionEvent[] {
        const { tokens, confs } = flattenFinal(result);
        const events: DetectionEvent[] = [];

        for (const word of this.words) {
            const occurrences = findOccurrences(tokens, word.tokens).map(start => {
                let conf: number | null = 1;
                for (let j = 0; j < word.tokens.length; j++) {
                    const c = confs[start + j];
                    // one unknown confidence makes the whole phrase unknown
                    conf = c == null || conf == null ? null : Math.min(conf, c);
                }
                return conf;
            });

            // an engine that reports no confidence can only be confirmed by presence
            const passing = occurrences.filter(c => c == null || c >= word.threshold);
            const failing = occurrences.filter(c => c != null && c < word.threshold);

            const fired = this.firedOnPartial.get(word.id) ?? 0;
            const confirmed = Math.min(fired, passing.length);

            for (let k = 0; k < confirmed; k++) {
                events.push({ type: "confirmed", wordId: word.id, confidence: passing[k] });
            }

            for (let k = 0; k < fired - confirmed; k++) {
                events.push({ type: "suspectedFalsePositive", wordId: word.id, confidence: failing[k] ?? null });
            }

            // occurrences the partials never fired for: final-only words, or a partial that missed
            for (let k = confirmed; k < passing.length; k++) {
                events.push({ type: "hit", wordId: word.id, source: "final", confidence: passing[k] });
            }
        }

        this.firedOnPartial.clear();
        return events;
    }
}

/** Final result → parallel token/confidence arrays, falling back to the plain text. */
function flattenFinal(result: FinalResult): { tokens: string[]; confs: (number | null)[]; } {
    const tokens: string[] = [];
    const confs: (number | null)[] = [];

    if (result?.words?.length) {
        for (const w of result.words) {
            const conf = typeof w.conf === "number" && Number.isFinite(w.conf) ? w.conf : null;
            for (const token of tokenize(w.word)) {
                tokens.push(token);
                confs.push(conf);
            }
        }
    } else {
        for (const token of tokenize(result?.text ?? "")) {
            tokens.push(token);
            confs.push(null);
        }
    }

    return { tokens, confs };
}
