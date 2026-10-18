/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type DetectionEvent, findOccurrences, HitDetector, isFinalOnly, normalizePhrase, phraseError, phraseVariants, pluralForms, tokenize, tokenMatches } from "./detection";

/*
 * Run with: npx tsx --test src/userplugins/mouthWash/*.test.ts src/userplugins/mouthWash/**\/*.test.ts
 */

const types = (events: DetectionEvent[]) => events.map(e => `${e.type}:${e.wordId}${e.type === "hit" ? `:${e.source}` : ""}`);

const words = (conf: number) => (text: string) => text.split(" ").map(word => ({ word, conf }));

describe("phrase validation", () => {
    it("normalises case and whitespace", () => {
        assert.equal(normalizePhrase("  Oh   MY  God "), "oh my god");
    });

    it("accepts lowercase words, digits and single spaces", () => {
        assert.equal(phraseError("like"), null);
        assert.equal(phraseError("oh my god"), null);
        assert.equal(phraseError("catch22"), null);
    });

    it("rejects punctuation, apostrophes, empty and double spaces", () => {
        assert.notEqual(phraseError(""), null);
        assert.notEqual(phraseError("don't"), null);
        assert.notEqual(phraseError("what?"), null);
        assert.notEqual(phraseError("oh  my"), null);
        assert.notEqual(phraseError(" like"), null);
        assert.notEqual(phraseError("Like"), null);
        assert.notEqual(phraseError("[unk]"), null);
    });

    it("switches to final-only at 0.95", () => {
        assert.equal(isFinalOnly(0.94), false);
        assert.equal(isFinalOnly(0.95), true);
        assert.equal(isFinalOnly(1), true);
    });
});

describe("tokenize", () => {
    it("lowercases and strips punctuation", () => {
        assert.deepEqual(tokenize("Oh, LIKE, really?!"), ["oh", "like", "really"]);
    });

    it("drops apostrophes instead of splitting on them", () => {
        assert.deepEqual(tokenize("don't"), ["dont"]);
        assert.deepEqual(tokenize("it’s"), ["its"]);
    });

    it("keeps [unk] as its own token", () => {
        assert.deepEqual(tokenize("fuck [unk] fuck"), ["fuck", "[unk]", "fuck"]);
    });

    it("keeps masked profanity", () => {
        assert.deepEqual(tokenize("what the f***"), ["what", "the", "f***"]);
    });

    it("handles empty and nullish input", () => {
        assert.deepEqual(tokenize(""), []);
        assert.deepEqual(tokenize(undefined as any), []);
    });
});

describe("tokenMatches", () => {
    it("matches exact tokens only, not substrings", () => {
        assert.equal(tokenMatches("like", "like"), true);
        assert.equal(tokenMatches("likely", "like"), false);
        assert.equal(tokenMatches("unlike", "like"), false);
    });

    it("matches masked tokens of the same length and first letter", () => {
        assert.equal(tokenMatches("f***", "fuck"), true);
        assert.equal(tokenMatches("s***", "fuck"), false);
        assert.equal(tokenMatches("f**", "fuck"), false);
        assert.equal(tokenMatches("f*****", "fuck"), false);
    });

    it("does not treat a lone asterisk run as a wildcard", () => {
        assert.equal(tokenMatches("****", "fuck"), false);
    });
});

describe("findOccurrences", () => {
    it("finds whole-token single words", () => {
        assert.deepEqual(findOccurrences(["i", "like", "it", "like"], ["like"]), [1, 3]);
    });

    it("finds multi-word phrases contiguously", () => {
        assert.deepEqual(findOccurrences(["oh", "my", "god"], ["oh", "my", "god"]), [0]);
        assert.deepEqual(findOccurrences(["oh", "[unk]", "my", "god"], ["oh", "my", "god"]), []);
    });

    it("does not overlap occurrences", () => {
        assert.deepEqual(findOccurrences(["no", "no", "no"], ["no", "no"]), [0]);
    });

    it("returns nothing for an empty phrase", () => {
        assert.deepEqual(findOccurrences(["a"], []), []);
    });
});

describe("pluralForms", () => {
    it("adds -s to ordinary words", () => {
        assert.deepEqual(pluralForms("fuck"), ["fucks"]);
        assert.deepEqual(pluralForms("shit"), ["shits"]);
        assert.deepEqual(pluralForms("retard"), ["retards"]);
    });

    it("adds -es after sibilants", () => {
        assert.ok(pluralForms("bitch").includes("bitches"));
        assert.ok(pluralForms("ass").includes("asses"));
        assert.ok(pluralForms("box").includes("boxes"));
    });

    it("turns consonant + y into -ies, but keeps vowel + y", () => {
        assert.ok(pluralForms("pussy").includes("pussies"));
        assert.deepEqual(pluralForms("guy"), ["guys"]);
    });

    it("handles -f / -fe", () => {
        assert.ok(pluralForms("knife").includes("knives"));
        assert.ok(pluralForms("leaf").includes("leaves"));
    });

    it("leaves digits, single letters and non-words alone", () => {
        assert.deepEqual(pluralForms("22"), []);
        assert.deepEqual(pluralForms("a"), []);
    });

    it("does not add -ing or -ed forms", () => {
        const forms = pluralForms("fuck");
        assert.ok(!forms.includes("fucking") && !forms.includes("fucked"));
    });
});

describe("phraseVariants", () => {
    it("pluralises only the last word of a phrase", () => {
        assert.deepEqual(phraseVariants("oh my god", true), ["oh my god", "oh my gods"]);
    });

    it("returns just the phrase when plurals are off", () => {
        assert.deepEqual(phraseVariants("fuck", false), ["fuck"]);
    });
});

describe("HitDetector — plurals", () => {
    const detector = (matchPlurals?: boolean) => new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75, matchPlurals }]);

    it("catches the plural by default", () => {
        assert.deepEqual(types(detector().onPartial("he gives no fucks")), ["hit:f:partial"]);
    });

    it("catches possessives, which arrive as -s once the apostrophe is dropped", () => {
        const d = new HitDetector([{ id: "s", phrase: "shit", threshold: 0.75 }]);
        assert.deepEqual(types(d.onPartial("that shit's wild")), ["hit:s:partial"]);
    });

    it("ignores plurals when turned off", () => {
        assert.deepEqual(detector(false).onPartial("no fucks given"), []);
        assert.deepEqual(types(detector(false).onPartial("fuck")), ["hit:f:partial"]);
    });

    it("still does not match unrelated longer words", () => {
        assert.deepEqual(detector().onPartial("fucking fucked fuckery"), []);
    });

    it("confirms a plural in the final result", () => {
        const d = detector();
        d.onPartial("fucks");
        assert.deepEqual(types(d.onFinal({ text: "fucks", words: words(0.9)("fucks") })), ["confirmed:f"]);
    });

    it("matches a plural at the end of a multi-word phrase", () => {
        const d = new HitDetector([{ id: "omg", phrase: "oh my god", threshold: 0.75 }]);
        assert.deepEqual(types(d.onPartial("oh my gods")), ["hit:omg:partial"]);
    });
});

describe("HitDetector — partials", () => {
    const detector = () => new HitDetector([
        { id: "f", phrase: "fuck", threshold: 0.75 },
        { id: "omg", phrase: "oh my god", threshold: 0.75 }
    ]);

    it("fires once when a word appears in a partial", () => {
        const d = detector();
        assert.deepEqual(types(d.onPartial("fuck")), ["hit:f:partial"]);
    });

    it("does not re-fire as the cumulative partial grows", () => {
        const d = detector();
        d.onPartial("fuck");
        assert.deepEqual(d.onPartial("fuck [unk]"), []);
        assert.deepEqual(d.onPartial("fuck [unk] [unk]"), []);
    });

    it("fires again for a second occurrence in the same utterance", () => {
        const d = detector();
        d.onPartial("fuck [unk]");
        assert.deepEqual(types(d.onPartial("fuck [unk] fuck")), ["hit:f:partial"]);
    });

    it("never fires for words not on the list", () => {
        const d = detector();
        assert.deepEqual(d.onPartial("duck luck truck [unk]"), []);
    });

    it("fires multi-word phrases only when complete", () => {
        const d = detector();
        assert.deepEqual(d.onPartial("oh my"), []);
        assert.deepEqual(types(d.onPartial("oh my god")), ["hit:omg:partial"]);
    });

    it("ignores partials for final-only words", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.95 }]);
        assert.deepEqual(d.onPartial("fuck"), []);
    });

    it("forgets utterance state on reset", () => {
        const d = detector();
        d.onPartial("fuck");
        d.reset();
        assert.deepEqual(types(d.onPartial("fuck")), ["hit:f:partial"]);
    });

    it("resets utterance state when the word list changes", () => {
        const d = detector();
        d.onPartial("fuck");
        d.setWords([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        assert.deepEqual(types(d.onPartial("fuck")), ["hit:f:partial"]);
    });
});

describe("HitDetector — finals", () => {
    it("confirms a partial hit backed by a confident final", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        d.onPartial("fuck");
        assert.deepEqual(types(d.onFinal({ text: "fuck", words: words(0.9)("fuck") })), ["confirmed:f"]);
    });

    it("flags a partial hit whose final confidence is under the threshold", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        d.onPartial("fuck");
        const events = d.onFinal({ text: "fuck", words: words(0.5)("fuck") });
        assert.deepEqual(types(events), ["suspectedFalsePositive:f"]);
        assert.equal(events[0].confidence, 0.5);
    });

    it("flags a partial hit the final dropped entirely, with null confidence", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        d.onPartial("fuck");
        const events = d.onFinal({ text: "[unk]", words: words(1)("[unk]") });
        assert.deepEqual(types(events), ["suspectedFalsePositive:f"]);
        assert.equal(events[0].confidence, null);
    });

    it("flags a partial hit when the final is empty", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        d.onPartial("fuck");
        assert.deepEqual(types(d.onFinal({ text: "", words: [] })), ["suspectedFalsePositive:f"]);
    });

    it("fires final-only words on a confident final", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.95 }]);
        d.onPartial("fuck");
        const events = d.onFinal({ text: "fuck", words: words(0.97)("fuck") });
        assert.deepEqual(types(events), ["hit:f:final"]);
        assert.equal(events[0].confidence, 0.97);
    });

    it("does not fire final-only words under their threshold", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.95 }]);
        assert.deepEqual(d.onFinal({ text: "fuck", words: words(0.9)("fuck") }), []);
    });

    it("fires late for an occurrence the partials missed", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        d.onPartial("[unk]");
        assert.deepEqual(types(d.onFinal({ text: "fuck", words: words(0.9)("fuck") })), ["hit:f:final"]);
    });

    it("uses the weakest word as a phrase's confidence", () => {
        const d = new HitDetector([{ id: "omg", phrase: "oh my god", threshold: 0.75 }]);
        d.onPartial("oh my god");
        const events = d.onFinal({
            text: "oh my god",
            words: [{ word: "oh", conf: 1 }, { word: "my", conf: 0.6 }, { word: "god", conf: 1 }]
        });
        assert.deepEqual(types(events), ["suspectedFalsePositive:omg"]);
        assert.equal(events[0].confidence, 0.6);
    });

    it("treats unknown confidence as confirmed by presence", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        d.onPartial("fuck");
        assert.deepEqual(types(d.onFinal({ text: "Fuck that.", words: [] })), ["confirmed:f"]);
    });

    it("confirms each of two partial hits separately", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        d.onPartial("fuck [unk] fuck");
        const events = d.onFinal({
            text: "fuck [unk] fuck",
            words: [{ word: "fuck", conf: 0.9 }, { word: "[unk]", conf: 1 }, { word: "fuck", conf: 0.4 }]
        });
        assert.deepEqual(types(events), ["confirmed:f", "suspectedFalsePositive:f"]);
    });

    it("starts a fresh utterance after a final", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        d.onPartial("fuck");
        d.onFinal({ text: "fuck", words: words(0.9)("fuck") });
        assert.deepEqual(types(d.onPartial("fuck")), ["hit:f:partial"]);
    });

    it("matches masked profanity in Web Speech finals", () => {
        const d = new HitDetector([{ id: "f", phrase: "fuck", threshold: 0.75 }]);
        assert.deepEqual(types(d.onFinal({ text: "what the f***", words: [] })), ["hit:f:final"]);
    });
});
