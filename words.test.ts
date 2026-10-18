/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_REACTION, makeWord, normalizeReactionInPlace, normalizeWordInPlace, normalizeWordList, phrasesFromVariableFilter } from "./words";

let n = 0;
const newId = () => `id${++n}`;

describe("normalizeWordInPlace", () => {
    it("fills in a bare word with conservative defaults", () => {
        const w = normalizeWordInPlace({ phrase: "Like" }, newId);
        assert.equal(w.phrase, "like");
        assert.equal(w.threshold, 0.75);
        assert.equal(w.cooldownMs, 3000);
        assert.equal(w.hitCount, 0);
        assert.equal(w.enabled, true);
        assert.equal(w.reaction, null);
        assert.ok(w.id);
    });

    it("turns plural matching on for words saved before the option existed, but respects an explicit off", () => {
        assert.equal(normalizeWordInPlace({ phrase: "fuck" }, newId).matchPlurals, true);
        assert.equal(normalizeWordInPlace({ phrase: "fuck", matchPlurals: false }, newId).matchPlurals, false);
    });

    it("clamps out-of-range numbers", () => {
        const w = normalizeWordInPlace({ phrase: "x", threshold: 7, cooldownMs: -5, hitCount: -3 }, newId);
        assert.equal(w.threshold, 1);
        assert.equal(w.cooldownMs, 0);
        assert.equal(w.hitCount, 0);
    });

    it("keeps but disables a word whose phrase is invalid", () => {
        const w = normalizeWordInPlace({ phrase: "don't", enabled: true }, newId);
        assert.equal(w.phrase, "don't");
        assert.equal(w.enabled, false);
    });

    it("respects an explicit disable", () => {
        assert.equal(normalizeWordInPlace({ phrase: "like", enabled: false }, newId).enabled, false);
    });

    it("normalises a per-word reaction and drops a junk one", () => {
        assert.equal(normalizeWordInPlace({ phrase: "a", reaction: "loud" }, newId).reaction, null);
        const w = normalizeWordInPlace({ phrase: "a", reaction: { kind: "nope", volume: 3 } }, newId);
        assert.equal(w.reaction!.kind, "buzzer");
        assert.equal(w.reaction!.volume, 1);
    });
});

describe("normalizeReactionInPlace", () => {
    it("keeps valid kinds and strips non-string extras", () => {
        const r = normalizeReactionInPlace({ kind: "tts", volume: 0.2, ttsText: "you said like", soundPath: 5 });
        assert.equal(r.kind, "tts");
        assert.equal(r.ttsText, "you said like");
        assert.equal("soundPath" in r, false);
        assert.equal(r.alsoToast, false);
    });

    it("gives a preset reaction a valid bundled clip", () => {
        assert.equal(normalizeReactionInPlace({ kind: "preset", volume: 1 }).preset, "incorrectBuzzer");
        assert.equal(normalizeReactionInPlace({ kind: "preset", volume: 1, preset: "airhorn" }).preset, "incorrectBuzzer");
        assert.equal(normalizeReactionInPlace({ kind: "preset", volume: 1, preset: "legoHey" }).preset, "legoHey");
    });

    it("remembers a valid preset choice across kind switches but drops an invalid one", () => {
        assert.equal(normalizeReactionInPlace({ kind: "beep", volume: 1, preset: "legoHey" }).preset, "legoHey");
        assert.equal("preset" in normalizeReactionInPlace({ kind: "beep", volume: 1, preset: "airhorn" }), false);
    });

    it("never mutates the shared default", () => {
        assert.ok(Object.isFrozen(DEFAULT_REACTION));
    });
});

describe("normalizeWordList", () => {
    it("returns an empty list for non-arrays", () => {
        assert.deepEqual(normalizeWordList({ words: [] }, newId), []);
        assert.deepEqual(normalizeWordList(null, newId), []);
    });

    it("drops junk entries and duplicate phrases, and re-ids duplicate ids", () => {
        const list = normalizeWordList([
            null,
            "like",
            { id: "a", phrase: "like" },
            { id: "a", phrase: "um" },
            { id: "c", phrase: "LIKE" }
        ], newId);
        assert.deepEqual(list.map(w => w.phrase), ["like", "um"]);
        assert.notEqual(list[0].id, list[1].id);
    });
});

describe("makeWord", () => {
    it("creates an enabled word with no hits", () => {
        const w = makeWord("literally", newId);
        assert.equal(w.enabled, true);
        assert.equal(w.hitCount, 0);
    });
});

describe("phrasesFromVariableFilter", () => {
    const rules = [
        { matchKind: "phrase", isRegex: false, pattern: "Heck" },
        { matchKind: "phrase", isRegex: true, pattern: "f+uck" },
        { matchKind: "link", isRegex: false, pattern: "crackbert.gif" },
        { matchKind: "phrase", isRegex: false, pattern: "what?" },
        { matchKind: "phrase", isRegex: false, pattern: "oh  my god" },
        { matchKind: "phrase", isRegex: false, pattern: "like" },
        { matchKind: "phrase", isRegex: false, pattern: "heck" },
        null
    ];

    it("takes only literal phrase rules that are valid spoken phrases and not already listed", () => {
        assert.deepEqual(phrasesFromVariableFilter(rules, ["like"]), ["heck", "oh my god"]);
    });

    it("tolerates VariableFilter being absent or malformed", () => {
        assert.deepEqual(phrasesFromVariableFilter(undefined, []), []);
        assert.deepEqual(phrasesFromVariableFilter("rules", []), []);
    });
});
