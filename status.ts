/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Observable runtime state for the status panel (§9.1). Written by the controller, read by the
 * settings UI. The input level has its own channel because it changes ~30 times a second and
 * should only re-render the meter, not the whole panel.
 */

import { useEffect, useReducer } from "@webpack/common";

import type { GateResult } from "./gate";
import type { EngineKind } from "./types";

export type EngineState =
    | "idle"
    | "resolving"
    /** no usable engine at all (§6.1 step 3) */
    | "unavailable"
    /** Vosk selected, model not downloaded — inert until the user accepts the download (§8.5) */
    | "needsModel"
    | "downloading"
    /** Vosk model cached and verified on disk, not loaded yet — loads when the gate opens */
    | "standby"
    | "loading"
    | "ready"
    | "error";

export type CaptureState = "closed" | "opening" | "open" | "error";

export type BannerAction = "retryEngine" | "downloadModel" | "enableListening";

export interface Banner {
    message: string;
    action?: BannerAction;
}

export interface RuntimeStatus {
    running: boolean;
    engineKind: EngineKind | null;
    engineState: EngineState;
    engineLabel: string;
    engineDetail: string | null;
    /** 0..1 while downloading */
    downloadProgress: number | null;
    downloadPhase: string | null;

    gate: GateResult | null;
    captureState: CaptureState;
    captureDevice: string | null;
    captureMode: "worklet" | "scriptProcessor" | null;
    outputDevice: string | null;

    /** a persistent failure (§10.3), shown as a banner until resolved */
    banner: Banner | null;
    /** a softer problem worth surfacing, e.g. no SPEAKING events seen */
    warning: string | null;
    /** wordId → why the engine refused it */
    rejected: Record<string, string>;
}

const initial = (): RuntimeStatus => ({
    running: false,
    engineKind: null,
    engineState: "idle",
    engineLabel: "Not started",
    engineDetail: null,
    downloadProgress: null,
    downloadPhase: null,
    gate: null,
    captureState: "closed",
    captureDevice: null,
    captureMode: null,
    outputDevice: null,
    banner: null,
    warning: null,
    rejected: {}
});

let status = initial();
const listeners = new Set<() => void>();

export const getStatus = (): Readonly<RuntimeStatus> => status;

export function setStatus(patch: Partial<RuntimeStatus>): void {
    status = { ...status, ...patch };
    listeners.forEach(l => l());
}

export function resetStatus(): void {
    status = initial();
    setLevel(0);
    listeners.forEach(l => l());
}

export function subscribeStatus(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

// #region level

let level = 0;
let levelNotifiedAt = 0;
const levelListeners = new Set<() => void>();
/** cap meter re-renders; the worklet posts ~33 frames a second */
const LEVEL_INTERVAL_MS = 66;

export const getLevel = () => level;

export function setLevel(rms: number): void {
    level = rms;
    const now = performance.now();
    if (rms === 0 || now - levelNotifiedAt >= LEVEL_INTERVAL_MS) {
        levelNotifiedAt = now;
        levelListeners.forEach(l => l());
    }
}

export function subscribeLevel(listener: () => void): () => void {
    levelListeners.add(listener);
    return () => void levelListeners.delete(listener);
}

// #endregion

/** Re-render whenever `subscribe` fires. */
export function useSubscription(subscribe: (listener: () => void) => () => void): void {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
    useEffect(() => subscribe(forceUpdate), [subscribe]);
}
