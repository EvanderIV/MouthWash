/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CooldownTracker } from "./cooldown";

describe("CooldownTracker", () => {
    it("lets the first hit through", () => {
        assert.equal(new CooldownTracker().tryFire("a", 3000, 1500, 0), true);
    });

    it("holds the per-word cooldown", () => {
        const c = new CooldownTracker();
        c.tryFire("a", 3000, 0, 0);
        assert.equal(c.tryFire("a", 3000, 0, 2999), false);
        assert.equal(c.tryFire("a", 3000, 0, 3000), true);
    });

    it("holds the global cooldown across different words", () => {
        const c = new CooldownTracker();
        c.tryFire("a", 0, 1500, 0);
        assert.equal(c.tryFire("b", 0, 1500, 1499), false);
        assert.equal(c.tryFire("b", 0, 1500, 1500), true);
    });

    it("fires once for a sentence with three target words", () => {
        const c = new CooldownTracker();
        const fired = [
            c.tryFire("a", 3000, 1500, 0),
            c.tryFire("b", 3000, 1500, 400),
            c.tryFire("c", 3000, 1500, 900)
        ].filter(Boolean);
        assert.equal(fired.length, 1);
    });

    it("does not let suppressed hits extend the cooldown", () => {
        const c = new CooldownTracker();
        c.tryFire("a", 3000, 0, 0);
        c.tryFire("a", 3000, 0, 2000); // suppressed
        assert.equal(c.tryFire("a", 3000, 0, 3000), true);
    });

    it("applies the longer of the two cooldowns", () => {
        const c = new CooldownTracker();
        c.tryFire("a", 500, 2000, 0);
        assert.equal(c.tryFire("a", 500, 2000, 1000), false, "global floor still holds");
    });

    it("treats negative cooldowns as zero", () => {
        const c = new CooldownTracker();
        c.tryFire("a", -1, -1, 0);
        assert.equal(c.tryFire("a", -1, -1, 0), true);
    });

    it("forgets everything on reset", () => {
        const c = new CooldownTracker();
        c.tryFire("a", 3000, 1500, 0);
        c.reset();
        assert.equal(c.tryFire("a", 3000, 1500, 1), true);
    });
});
