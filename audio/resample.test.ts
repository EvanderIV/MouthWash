/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createResampler, frameRms } from "./resample";
import { WORKLET_PRELUDE } from "./worklet";

function sine(freq: number, rate: number, seconds: number): Float32Array {
    const out = new Float32Array(Math.round(rate * seconds));
    for (let i = 0; i < out.length; i++) out[i] = Math.sin(2 * Math.PI * freq * i / rate);
    return out;
}

/** Run a whole signal through a resampler in fixed-size chunks, like the worklet does. */
function run(inRate: number, outRate: number, signal: Float32Array, chunk = 128): Float32Array {
    const r = createResampler(inRate, outRate);
    const parts: number[] = [];
    const out = new Float32Array(Math.ceil(chunk * outRate / inRate) + 2);
    for (let i = 0; i < signal.length; i += chunk) {
        const n = r.process(signal.subarray(i, i + chunk), out);
        for (let k = 0; k < n; k++) parts.push(out[k]);
    }
    return Float32Array.from(parts);
}

/** RMS of the steady-state part, skipping the filter's warm-up. */
const steadyRms = (x: Float32Array) => frameRms(x.subarray(Math.floor(x.length / 4)));

describe("createResampler", () => {
    it("produces a third as many samples for 48k → 16k", () => {
        const out = run(48000, 16000, sine(440, 48000, 1));
        assert.ok(Math.abs(out.length - 16000) <= 2, `got ${out.length}`);
    });

    it("handles non-integer ratios (44.1k → 16k)", () => {
        const out = run(44100, 16000, sine(440, 44100, 1));
        assert.ok(Math.abs(out.length - 16000) <= 2, `got ${out.length}`);
    });

    it("passes speech-band tones at roughly unity gain", () => {
        for (const freq of [200, 1000, 3000, 5500]) {
            const rms = steadyRms(run(48000, 16000, sine(freq, 48000, 0.5)));
            // a unit sine has RMS 1/√2
            assert.ok(Math.abs(rms - Math.SQRT1_2) < 0.08, `${freq} Hz → RMS ${rms.toFixed(3)}`);
        }
    });

    it("keeps the frequency of a passed tone", () => {
        const out = run(48000, 16000, sine(1000, 48000, 0.5));
        let crossings = 0;
        for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 !== out[i] < 0) crossings++;
        // 1 kHz for 0.5 s → ~1000 zero crossings
        assert.ok(Math.abs(crossings - 1000) < 20, `got ${crossings}`);
    });

    it("attenuates content above the output Nyquist instead of aliasing it", () => {
        for (const freq of [10000, 12000, 15000, 20000]) {
            const rms = steadyRms(run(48000, 16000, sine(freq, 48000, 0.5)));
            assert.ok(rms < 0.05, `${freq} Hz leaked through with RMS ${rms.toFixed(3)}`);
        }
    });

    it("gives the same output regardless of chunk size", () => {
        const signal = sine(700, 48000, 0.25);
        const a = run(48000, 16000, signal, 128);
        const b = run(48000, 16000, signal, 1000);
        assert.equal(a.length, b.length);
        for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-5, `differs at ${i}`);
    });

    it("passes DC at unity gain", () => {
        const out = run(48000, 16000, new Float32Array(4800).fill(0.5));
        assert.ok(Math.abs(out[out.length - 1] - 0.5) < 1e-3);
    });

    it("stays self-contained so it can be injected into the worklet", () => {
        // what worklet.ts does: rebuild the factory from its own source text, with only the prelude
        const rebuilt = new Function(`${WORKLET_PRELUDE}\nreturn (${createResampler.toString()});`)() as typeof createResampler;
        const r = rebuilt(48000, 16000);
        const out = new Float32Array(64);
        assert.ok(r.process(sine(440, 48000, 0.01), out) > 0);
    });

    it("never writes past the output buffer it is given", () => {
        const r = createResampler(48000, 16000);
        const out = new Float32Array(4);
        assert.equal(r.process(new Float32Array(480), out), 4);
        // the rest comes out on the next call instead of being lost
        assert.ok(r.process(new Float32Array(0), new Float32Array(400)) > 100);
    });
});

describe("frameRms", () => {
    it("is zero for silence and empty frames", () => {
        assert.equal(frameRms(new Float32Array(10)), 0);
        assert.equal(frameRms(new Float32Array(0)), 0);
    });

    it("is the amplitude for a constant signal", () => {
        assert.ok(Math.abs(frameRms(new Float32Array(10).fill(-0.25)) - 0.25) < 1e-7);
    });
});
