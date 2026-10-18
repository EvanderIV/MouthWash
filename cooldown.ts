/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Pure cooldown bookkeeping (§10.2). No Vencord/webpack/DOM imports — see cooldown.test.ts.
 *
 * Two layers, both measured from the last time a reaction actually *fired*:
 *  1. per word — ignore repeats of the same word for its `cooldownMs`;
 *  2. global   — a floor across all words, so a sentence with three target words buzzes once.
 */
export class CooldownTracker {
    private lastWordFire = new Map<string, number>();
    private lastGlobalFire = -Infinity;

    /**
     * Whether a hit on `wordId` at `now` may fire. When it may, the fire is recorded, so call
     * this exactly once per hit. Suppressed hits are not recorded and do not extend a cooldown.
     */
    tryFire(wordId: string, wordCooldownMs: number, globalCooldownMs: number, now: number): boolean {
        if (now - this.lastGlobalFire < Math.max(0, globalCooldownMs)) return false;

        const last = this.lastWordFire.get(wordId) ?? -Infinity;
        if (now - last < Math.max(0, wordCooldownMs)) return false;

        this.lastWordFire.set(wordId, now);
        this.lastGlobalFire = now;
        return true;
    }

    reset(): void {
        this.lastWordFire.clear();
        this.lastGlobalFire = -Infinity;
    }
}
