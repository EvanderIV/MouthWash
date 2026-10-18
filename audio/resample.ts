/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Pure streaming resampler, 48 kHz (or whatever the device runs at) → 16 kHz mono (§6.6).
 * No Vencord/webpack/DOM imports — see resample.test.ts.
 *
 * IMPORTANT: `createResampler` is also injected into the AudioWorklet by source text
 * (`createResampler.toString()`, see worklet.ts), because a worklet cannot import modules.
 * It must therefore stay completely self-contained: no references to anything outside its own
 * body — no module constants, no imports, no helpers. (The one exception is esbuild's
 * `__name()` keep-names helper, which the worklet shims — see WORKLET_PRELUDE.)
 */

export interface Resampler {
    /**
     * Push input samples, write as many output samples as are ready into `out`, and return how
     * many were written. `out` must hold at least `Math.ceil(input.length * outRate / inRate) + 2`.
     * Allocates only when an input chunk is larger than any seen before.
     */
    process(input: Float32Array, out: Float32Array): number;
}

/**
 * Windowed-sinc low-pass (Blackman window) followed by fractional decimation with linear
 * interpolation between filtered samples. The low-pass removes everything above ~90% of the
 * output Nyquist so 8–24 kHz content does not alias into the speech band; correctness matters
 * far more than fidelity at 16 kHz.
 */
export function createResampler(inRate: number, outRate: number): Resampler {
    const ratio = inRate / outRate;
    // odd tap count, scaled with the ratio so the transition band stays ~2.5 kHz wide: flat to
    // ~6 kHz, stopband from ~8.5 kHz. 97 taps at 48k → 16k is ~3M multiply-adds a second.
    const taps = Math.max(31, Math.ceil(ratio * 32)) | 1;
    const half = (taps - 1) / 2;
    // cutoff in cycles per input sample
    const cutoff = ratio > 1 ? 0.45 / ratio : 0.45;

    const kernel = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
        const m = i - half;
        const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
        kernel[i] = sinc * w;
        sum += kernel[i];
    }
    // unity gain at DC
    for (let i = 0; i < taps; i++) kernel[i] /= sum;

    // buf holds [history (taps - 1 samples) | new input]; starts as silence
    let buf = new Float32Array(taps - 1 + 1024);
    let held = taps - 1;
    // position (in buf indices) of the next output sample; the first fully-backed index
    let pos = taps - 1;

    function fir(newest: number): number {
        let acc = 0;
        const start = newest - (taps - 1);
        for (let j = 0; j < taps; j++) acc += kernel[j] * buf[start + j];
        return acc;
    }

    return {
        process(input: Float32Array, out: Float32Array): number {
            if (held + input.length > buf.length) {
                const grown = new Float32Array(held + input.length);
                grown.set(buf.subarray(0, held));
                buf = grown;
            }

            buf.set(input, held);
            held += input.length;

            let n = 0;
            while (Math.floor(pos) + 1 < held && n < out.length) {
                const i0 = Math.floor(pos);
                const frac = pos - i0;
                const a = fir(i0);
                out[n++] = frac > 0 ? a + (fir(i0 + 1) - a) * frac : a;
                pos += ratio;
            }

            // drop everything older than the window the next output needs
            const shift = Math.min(Math.floor(pos) - (taps - 1), held - (taps - 1));
            if (shift > 0) {
                buf.copyWithin(0, shift, held);
                held -= shift;
                pos -= shift;
            }

            return n;
        }
    };
}

/** Root-mean-square level of a frame, 0..1 for normalised float audio. */
export function frameRms(samples: Float32Array): number {
    if (!samples.length) return 0;
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    return Math.sqrt(sumSq / samples.length);
}
