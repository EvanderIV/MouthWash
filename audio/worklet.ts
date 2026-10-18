/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The AudioWorklet source, as a string (§8.2).
 *
 * A bundled separate file would not resolve inside Discord's renderer, so the processor is
 * assembled here and loaded with `audioWorklet.addModule(URL.createObjectURL(...))`.
 *
 * Deliberately minimal — it runs on the audio thread and anything slow causes dropouts:
 *  1. resample each 128-sample render quantum to 16 kHz (§6.6);
 *  2. accumulate into ~30 ms frames, computing the frame RMS on the way;
 *  3. post each frame (and its RMS) to the main thread, transferring the buffer.
 *
 * No DOM imports here either, so the resampler-injection test can import it.
 */

import { createResampler } from "./resample";

export const WORKLET_NAME = "mouthwash-tap";
export const TARGET_SAMPLE_RATE = 16000;
export const FRAME_MS = 30;

/**
 * esbuild's keep-names mode wraps named functions in `__name(fn, "name")` calls that reference
 * a module-level helper. Injected source has no such helper, so give it a no-op one.
 */
export const WORKLET_PRELUDE = "var __name = function (target) { return target; };";

export interface WorkletFrame {
    samples: Float32Array;
    rms: number;
}

export function buildWorkletSource(): string {
    return `${WORKLET_PRELUDE}
const createResampler = (${createResampler.toString()});

class MouthWashTap extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        const outRate = opts.outRate || ${TARGET_SAMPLE_RATE};
        this.frameSize = Math.round(outRate * (opts.frameMs || ${FRAME_MS}) / 1000);
        this.resampler = createResampler(sampleRate, outRate);
        // a render quantum is 128 samples; leave headroom for any input rate
        this.scratch = new Float32Array(256);
        this.frame = new Float32Array(this.frameSize);
        this.fill = 0;
        this.sumSq = 0;
        this.alive = true;
        this.port.onmessage = e => { if (e.data === "stop") this.alive = false; };
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel && this.alive) {
            const n = this.resampler.process(channel, this.scratch);
            for (let i = 0; i < n; i++) {
                const s = this.scratch[i];
                this.frame[this.fill++] = s;
                this.sumSq += s * s;

                if (this.fill === this.frameSize) {
                    // The frame is the only allocation: it is transferred, not copied, so the
                    // main thread owns it outright. Nothing else is retained here.
                    const samples = this.frame;
                    const rms = Math.sqrt(this.sumSq / this.frameSize);
                    this.port.postMessage({ samples, rms }, [samples.buffer]);
                    this.frame = new Float32Array(this.frameSize);
                    this.fill = 0;
                    this.sumSq = 0;
                }
            }
        }
        // returning false lets the node be collected once "stop" has been posted
        return this.alive;
    }
}

registerProcessor(${JSON.stringify(WORKLET_NAME)}, MouthWashTap);
`;
}
