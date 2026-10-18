/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The second, independent microphone capture (§7.3, §8.1).
 *
 * getUserMedia → AudioContext → MediaStreamSource → AudioWorkletNode("mouthwash-tap"), which
 * posts 16 kHz frames back here. This never touches Discord's own media engine or its transmit
 * path, so nothing that happens in here can affect what the call hears.
 *
 * Privacy: frames are handed to `onFrame` and not kept. Nothing in this file buffers audio
 * beyond the frame being assembled, and nothing writes it anywhere.
 */

import { logOnce } from "../fluxEvents";
import type { ResolvedDevice } from "./devices";
import { createResampler } from "./resample";
import { buildWorkletSource, FRAME_MS, TARGET_SAMPLE_RATE, WORKLET_NAME, type WorkletFrame } from "./worklet";

export type CaptureErrorKind = "permission" | "busy" | "notFound" | "unknown";

export class CaptureError extends Error {
    constructor(message: string, readonly kind: CaptureErrorKind, readonly deviceLabel: string) {
        super(message);
    }
}

export interface CaptureHandlers {
    onFrame(samples: Float32Array, rms: number): void;
    /** the track ended underneath us (device unplugged, permission revoked) */
    onEnded(reason: string): void;
}

function describeError(e: unknown, deviceLabel: string): CaptureError {
    const name = (e as any)?.name ?? "";
    switch (name) {
        case "NotAllowedError":
        case "SecurityError":
            return new CaptureError("Microphone permission was denied.", "permission", deviceLabel);
        case "NotReadableError":
        case "AbortError":
            return new CaptureError(
                `"${deviceLabel}" refused a second capture. Some audio interfaces and exclusive-mode drivers only allow one app at a time.`,
                "busy",
                deviceLabel
            );
        case "NotFoundError":
        case "OverconstrainedError":
            return new CaptureError(`Microphone "${deviceLabel}" was not found.`, "notFound", deviceLabel);
        default:
            return new CaptureError(`Could not open the microphone: ${(e as any)?.message ?? String(e)}`, "unknown", deviceLabel);
    }
}

async function getStream(deviceId: string | undefined): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
        audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            // match what Discord sends, so the recognizer hears roughly what the call hears
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: { ideal: 1 }
        },
        video: false
    });
}

function createContext(): AudioContext {
    // The capture graph produces no sound. Where supported, render it to no output device at
    // all, so opening the mic does not also open (and wake) a speaker.
    try {
        return new AudioContext({ latencyHint: "interactive", sinkId: { type: "none" } } as AudioContextOptions);
    } catch {
        return new AudioContext({ latencyHint: "interactive" });
    }
}

/** Groups resampled samples into fixed frames — the worklet's job, for the fallback path. */
function frameAssembler(onFrame: CaptureHandlers["onFrame"]) {
    const frameSize = Math.round(TARGET_SAMPLE_RATE * FRAME_MS / 1000);
    let frame = new Float32Array(frameSize);
    let fill = 0;
    let sumSq = 0;

    return (samples: Float32Array, count: number) => {
        for (let i = 0; i < count; i++) {
            const s = samples[i];
            frame[fill++] = s;
            sumSq += s * s;
            if (fill === frameSize) {
                const done = frame;
                const rms = Math.sqrt(sumSq / frameSize);
                frame = new Float32Array(frameSize);
                fill = 0;
                sumSq = 0;
                onFrame(done, rms);
            }
        }
    };
}

/**
 * Fallback for when the worklet module cannot load (e.g. a CSP that blocks blob: scripts).
 * ScriptProcessorNode is deprecated and runs on the main thread, but the work per callback is a
 * small FIR filter — far cheaper than not working at all. Adds ~20 ms of buffering latency.
 */
function createScriptProcessorTap(ctx: AudioContext, handlers: CaptureHandlers): ScriptProcessorNode {
    const node = ctx.createScriptProcessor(1024, 1, 1);
    const resampler = createResampler(ctx.sampleRate, TARGET_SAMPLE_RATE);
    const scratch = new Float32Array(Math.ceil(1024 * TARGET_SAMPLE_RATE / ctx.sampleRate) + 2);
    const push = frameAssembler(handlers.onFrame);

    node.onaudioprocess = e => {
        const n = resampler.process(e.inputBuffer.getChannelData(0), scratch);
        push(scratch, n);
    };

    return node;
}

async function createWorkletTap(ctx: AudioContext, handlers: CaptureHandlers): Promise<AudioWorkletNode> {
    const url = URL.createObjectURL(new Blob([buildWorkletSource()], { type: "application/javascript" }));
    try {
        await ctx.audioWorklet.addModule(url);
    } finally {
        URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { outRate: TARGET_SAMPLE_RATE, frameMs: FRAME_MS }
    });

    node.port.onmessage = (e: MessageEvent<WorkletFrame>) => {
        if (e.data?.samples) handlers.onFrame(e.data.samples, e.data.rms);
    };

    return node;
}

export class Capture {
    private closed = false;

    private constructor(
        readonly stream: MediaStream,
        private readonly ctx: AudioContext,
        private readonly nodes: AudioNode[],
        private readonly tap: AudioWorkletNode | ScriptProcessorNode,
        readonly deviceLabel: string,
        readonly mode: "worklet" | "scriptProcessor"
    ) { }

    get track(): MediaStreamTrack | null {
        return this.stream.getAudioTracks()[0] ?? null;
    }

    get contextState(): AudioContextState | "closed" {
        return this.closed ? "closed" : this.ctx.state;
    }

    static async open(device: ResolvedDevice, handlers: CaptureHandlers): Promise<Capture> {
        let stream: MediaStream;
        let { label } = device;

        try {
            stream = await getStream(device.deviceId);
        } catch (e) {
            const name = (e as any)?.name;
            // a stale device id should not cost the user their reaction; try the default mic
            if (device.deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) {
                try {
                    stream = await getStream(undefined);
                    label = "System default";
                } catch (e2) {
                    throw describeError(e2, "System default");
                }
            } else {
                throw describeError(e, label);
            }
        }

        const track = stream.getAudioTracks()[0];
        label = track?.label || label;

        let ctx: AudioContext | null = null;
        try {
            ctx = createContext();
            const source = ctx.createMediaStreamSource(stream);

            let tap: AudioWorkletNode | ScriptProcessorNode;
            let mode: "worklet" | "scriptProcessor" = "worklet";
            try {
                tap = await createWorkletTap(ctx, handlers);
            } catch (e) {
                logOnce("worklet", "AudioWorklet unavailable — falling back to ScriptProcessorNode", e);
                tap = createScriptProcessorTap(ctx, handlers);
                mode = "scriptProcessor";
            }

            // the graph has to reach the destination to be pulled; a zero gain keeps it silent
            const silent = ctx.createGain();
            silent.gain.value = 0;
            source.connect(tap);
            tap.connect(silent);
            silent.connect(ctx.destination);

            if (ctx.state === "suspended") await ctx.resume().catch(() => { });

            const capture = new Capture(stream, ctx, [source, tap, silent], tap, label, mode);
            track?.addEventListener("ended", () => {
                if (!capture.closed) handlers.onEnded(`The microphone "${label}" stopped.`);
            });

            return capture;
        } catch (e) {
            stream.getTracks().forEach(t => t.stop());
            ctx?.close().catch(() => { });
            throw describeError(e, label);
        }
    }

    /** Stop every track and close the context (§7.2). Safe to call more than once. */
    close(): void {
        if (this.closed) return;
        this.closed = true;

        try {
            if (this.tap instanceof AudioWorkletNode) {
                this.tap.port.onmessage = null;
                this.tap.port.postMessage("stop");
                this.tap.port.close();
            } else {
                this.tap.onaudioprocess = null;
            }
        } catch { }

        for (const node of this.nodes) {
            try {
                node.disconnect();
            } catch { }
        }

        this.stream.getTracks().forEach(t => t.stop());
        this.ctx.close().catch(() => { });
    }
}
