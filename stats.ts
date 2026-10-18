/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * In-memory session counters (§9.4).
 *
 * Only aggregate counts and the matched phrase are kept — never recognizer text, never audio.
 * Everything here is lost when Discord restarts or the plugin stops; the only persisted figure
 * is each word's lifetime `hitCount`, which lives in the settings file.
 */

export interface WordSessionStats {
    /** every detection, including ones a cooldown swallowed */
    hits: number;
    /** detections that actually played a reaction */
    fired: number;
    /** partial hits the final result backed up */
    confirmed: number;
    /** partial hits the final result did not back up (§6.5) */
    suspected: number;
    /** the most recent suspected false positive's final confidence; null = word absent from the final */
    lastSuspectedConfidence: number | null | undefined;
}

export interface Detection {
    wordId: string;
    phrase: string;
    at: number;
    fired: boolean;
}

let sessionStartedAt = Date.now();
let session = new Map<string, WordSessionStats>();
let lastDetection: Detection | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(l => l());

function entry(wordId: string): WordSessionStats {
    let stats = session.get(wordId);
    if (!stats) {
        stats = { hits: 0, fired: 0, confirmed: 0, suspected: 0, lastSuspectedConfidence: undefined };
        session.set(wordId, stats);
    }
    return stats;
}

export function recordHit(wordId: string, phrase: string, fired: boolean): void {
    const stats = entry(wordId);
    stats.hits++;
    if (fired) stats.fired++;
    lastDetection = { wordId, phrase, at: Date.now(), fired };
    notify();
}

export function recordConfirmed(wordId: string): void {
    entry(wordId).confirmed++;
    notify();
}

export function recordSuspected(wordId: string, confidence: number | null): void {
    const stats = entry(wordId);
    stats.suspected++;
    stats.lastSuspectedConfidence = confidence;
    notify();
}

export const getSessionStats = (wordId: string): WordSessionStats | undefined => session.get(wordId);
export const getLastDetection = () => lastDetection;
export const getSessionStartedAt = () => sessionStartedAt;

export function getSessionTotals(): { hits: number; fired: number; suspected: number; } {
    let hits = 0, fired = 0, suspected = 0;
    for (const s of session.values()) {
        hits += s.hits;
        fired += s.fired;
        suspected += s.suspected;
    }
    return { hits, fired, suspected };
}

export function forgetWord(wordId: string): void {
    session.delete(wordId);
    if (lastDetection?.wordId === wordId) lastDetection = null;
    notify();
}

export function resetSession(): void {
    session = new Map();
    lastDetection = null;
    sessionStartedAt = Date.now();
    notify();
}

export function subscribeStats(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}
