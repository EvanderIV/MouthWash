/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateGate, type GateInputs, type GateSettings, LevelGate, speakingFromEvent } from "./gate";

const defaults: GateSettings = {
    listening: true,
    requireVoiceConnection: true,
    requireUnmuted: true,
    requireTransmitting: true,
    listenInDMCalls: true
};

const talking: GateInputs = { inVoice: true, isDMCall: false, muted: false, transmitting: true };

describe("evaluateGate", () => {
    it("listens when every condition holds", () => {
        const g = evaluateGate(talking, defaults);
        assert.equal(g.captureOpen, true);
        assert.equal(g.feeding, true);
        assert.equal(g.blockedBy, null);
    });

    it("keeps the mic open but stops feeding between push-to-talk presses", () => {
        const g = evaluateGate({ ...talking, transmitting: false }, defaults);
        assert.equal(g.captureOpen, true);
        assert.equal(g.feeding, false);
        assert.equal(g.blockedBy?.id, "transmitting");
    });

    it("closes the mic outside a voice call", () => {
        const g = evaluateGate({ ...talking, inVoice: false, isDMCall: null }, defaults);
        assert.equal(g.captureOpen, false);
        assert.equal(g.feeding, false);
        assert.equal(g.blockedBy?.id, "voice");
    });

    it("closes the mic when muted", () => {
        const g = evaluateGate({ ...talking, muted: true }, defaults);
        assert.equal(g.captureOpen, false);
        assert.equal(g.blockedBy?.id, "unmuted");
    });

    it("closes everything when the master switch is off", () => {
        const g = evaluateGate(talking, { ...defaults, listening: false });
        assert.equal(g.captureOpen, false);
        assert.equal(g.blockedBy?.id, "listening");
    });

    it("blocks DM calls only when DM listening is off", () => {
        assert.equal(evaluateGate({ ...talking, isDMCall: true }, defaults).feeding, true);

        const off = { ...defaults, listenInDMCalls: false };
        assert.equal(evaluateGate({ ...talking, isDMCall: true }, off).captureOpen, false);
        assert.equal(evaluateGate({ ...talking, isDMCall: false }, off).captureOpen, true);
        assert.equal(evaluateGate({ ...talking, isDMCall: null }, off).captureOpen, true);
    });

    it("lets the user drop individual requirements", () => {
        const loose = { ...defaults, requireUnmuted: false, requireTransmitting: false };
        const g = evaluateGate({ ...talking, muted: true, transmitting: false }, loose);
        assert.equal(g.feeding, true);
        // still shown as failing, just not blocking
        assert.equal(g.checks.find(c => c.id === "unmuted")!.ok, false);
        assert.equal(g.checks.find(c => c.id === "unmuted")!.required, false);
    });

    it("can listen outside calls when voice connection is not required", () => {
        const g = evaluateGate({ inVoice: false, isDMCall: null, muted: false, transmitting: true }, { ...defaults, requireVoiceConnection: false });
        assert.equal(g.feeding, true);
    });

    it("fails closed when the store read failed, whatever is required", () => {
        const allOff = { ...defaults, requireVoiceConnection: false, requireUnmuted: false, requireTransmitting: false };
        const g = evaluateGate({ ...talking, readFailed: true }, allOff);
        assert.equal(g.captureOpen, false);
        assert.equal(g.feeding, false);
    });

    it("reports checks in a stable order for the status checklist", () => {
        assert.deepEqual(evaluateGate(talking, defaults).checks.map(c => c.id), ["listening", "voice", "dm", "unmuted", "transmitting"]);
    });
});

describe("speakingFromEvent", () => {
    it("reads voice speaking flags for the current user", () => {
        assert.equal(speakingFromEvent({ userId: "me", speakingFlags: 1 }, "me"), true);
        assert.equal(speakingFromEvent({ userId: "me", speakingFlags: 0 }, "me"), false);
        assert.equal(speakingFromEvent({ userId: "me", speakingFlags: 5 }, "me"), true);
    });

    it("does not count soundshare alone as talking", () => {
        assert.equal(speakingFromEvent({ userId: "me", speakingFlags: 2 }, "me"), false);
    });

    it("ignores other users and the stream context", () => {
        assert.equal(speakingFromEvent({ userId: "them", speakingFlags: 1 }, "me"), null);
        assert.equal(speakingFromEvent({ userId: "me", speakingFlags: 1, context: "stream" }, "me"), null);
        assert.equal(speakingFromEvent({ userId: "me", speakingFlags: 1, context: "default" }, "me"), true);
    });

    it("accepts a boolean speaking field from older payloads", () => {
        assert.equal(speakingFromEvent({ userId: "me", speaking: true }, "me"), true);
    });

    it("returns null for unreadable payloads", () => {
        assert.equal(speakingFromEvent({ userId: "me" }, "me"), null);
        assert.equal(speakingFromEvent(null, "me"), null);
        assert.equal(speakingFromEvent({ userId: "me", speakingFlags: 1 }, undefined), null);
    });
});

describe("LevelGate", () => {
    it("opens on a loud frame and holds through the hangover", () => {
        const g = new LevelGate(400);
        assert.equal(g.update(0.001, 0.02, 0), false);
        assert.equal(g.update(0.1, 0.02, 100), true);
        assert.equal(g.update(0.001, 0.02, 500), true);
        assert.equal(g.update(0.001, 0.02, 501), false);
    });

    it("forgets on reset", () => {
        const g = new LevelGate(400);
        g.update(1, 0.02, 0);
        g.reset();
        assert.equal(g.update(0, 0.02, 1), false);
    });
});
