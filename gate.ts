/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * "Should we be listening" — the whole decision, as a pure function (§7). Reading Discord's
 * stores happens in fluxEvents.ts; this module only combines what was read with the settings,
 * so it can be unit-tested (gate.test.ts).
 *
 * The decision has two levels:
 *
 *  - `captureOpen` — may the microphone be open at all? Everything except "transmitting".
 *  - `feeding`     — may audio reach the recognizer right now? `captureOpen` plus transmitting.
 *
 * The split exists because opening a mic takes a few hundred milliseconds. Gating the *mic* on
 * push-to-talk would either swallow the first word of every press or, with the §7.2 debounce,
 * the first 750 ms of it. So the mic opens once per call (debounced), and the transmit gate
 * decides frame by frame whether audio is processed. Audio that arrives while not transmitting
 * is never recognized: it only ever sits in a ~300 ms pre-roll ring buffer that is overwritten
 * continuously (§12), and is dropped entirely under push-to-talk.
 */

export interface GateSettings {
    listening: boolean;
    requireVoiceConnection: boolean;
    requireUnmuted: boolean;
    requireTransmitting: boolean;
    listenInDMCalls: boolean;
}

export interface GateInputs {
    /** connected to any voice channel or call */
    inVoice: boolean;
    /** the connected channel is a DM or group DM call; null when not connected or unknown */
    isDMCall: boolean | null;
    /** self-muted, server-muted or suppressed */
    muted: boolean;
    /** Discord (or the level fallback) says we are transmitting voice right now */
    transmitting: boolean;
    /** the store read failed — the gate must fail closed */
    readFailed?: boolean;
}

export type GateCheckId = "listening" | "voice" | "dm" | "unmuted" | "transmitting";

export interface GateCheck {
    id: GateCheckId;
    label: string;
    ok: boolean;
    /** false when the user turned this condition off — it is shown but never blocks */
    required: boolean;
}

export interface GateResult {
    checks: GateCheck[];
    captureOpen: boolean;
    feeding: boolean;
    /** the first check that is required and failing, for the "not listening — …" summary */
    blockedBy: GateCheck | null;
}

export function evaluateGate(inputs: GateInputs, s: GateSettings): GateResult {
    const failed = !!inputs.readFailed;

    const checks: GateCheck[] = [
        { id: "listening", label: "Listening switched on", ok: s.listening, required: true },
        { id: "voice", label: "In a voice call", ok: !failed && inputs.inVoice, required: s.requireVoiceConnection },
        {
            id: "dm",
            label: "DM calls allowed",
            // only blocks when actually in a DM call with DM listening off
            ok: !failed && (s.listenInDMCalls || inputs.isDMCall !== true),
            required: true
        },
        { id: "unmuted", label: "Unmuted", ok: !failed && !inputs.muted, required: s.requireUnmuted },
        { id: "transmitting", label: "Transmitting", ok: !failed && inputs.transmitting, required: s.requireTransmitting }
    ];

    // a failed store read blocks everything regardless of which checks are required (§7)
    const blocks = (c: GateCheck) => !c.ok && (c.required || failed);

    const captureChecks = checks.filter(c => c.id !== "transmitting");
    const captureOpen = !captureChecks.some(blocks);
    const feeding = captureOpen && !blocks(checks.find(c => c.id === "transmitting")!);

    return {
        checks,
        captureOpen,
        feeding,
        blockedBy: checks.find(blocks) ?? null
    };
}

/**
 * Speaking flags on Discord's SPEAKING event: bit 0 is voice, bit 1 soundshare, bit 2 priority.
 * Only voice counts — streaming a game's audio is not the user talking.
 */
export const SPEAKING_FLAG_VOICE = 1;

/** Interpret a SPEAKING event payload. Null when it is not about `userId` or is unreadable. */
export function speakingFromEvent(event: any, userId: string | undefined): boolean | null {
    if (!event || !userId || event.userId !== userId) return null;
    if (event.context != null && event.context !== "default") return null;

    if (typeof event.speakingFlags === "number") return (event.speakingFlags & SPEAKING_FLAG_VOICE) !== 0;
    if (typeof event.speaking === "boolean") return event.speaking;
    if (typeof event.speaking === "number") return (event.speaking & SPEAKING_FLAG_VOICE) !== 0;

    return null;
}

/**
 * The §7.1 fallback: decide "transmitting" from frame RMS, with hysteresis and a hangover so
 * a word's quiet tail is not cut off. Strictly worse than Discord's own VAD; debugging only.
 */
export class LevelGate {
    private lastLoudAt = -Infinity;

    constructor(private hangoverMs = 400) { }

    /** Returns whether we count as transmitting after this frame. */
    update(rms: number, threshold: number, now: number): boolean {
        if (rms >= threshold) this.lastLoudAt = now;
        return now - this.lastLoudAt <= this.hangoverMs;
    }

    reset(): void {
        this.lastLoudAt = -Infinity;
    }
}
