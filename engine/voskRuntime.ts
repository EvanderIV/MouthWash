/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Turning the verified vosk-browser bundle into a usable module. Pure — see voskRuntime.test.ts.
 *
 * vosk-browser's recognition worker mounts Emscripten's IDBFS and writes the *extracted* model
 * (~70 MB) into IndexedDB on every load, keyed by the model URL. MouthWash hands it a fresh blob:
 * URL each session, so left alone that would pile up a new, unverified copy of the model in
 * IndexedDB every time — and on a cache hit it would load that copy without any hash check.
 *
 * So after the bundle passes its SHA-256 check, one deterministic edit is applied to the worker
 * source inlined in it: the IDBFS mount is removed. The model then lives only in the worker's
 * memory, extracted from the verified archive, and is gone when the worker is terminated. The
 * edit is applied only if the exact expected line occurs exactly once; otherwise the bundle is
 * used unpatched and the caller falls back to deleting the database around each load.
 */

const WORKER_FACTORY = /createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'/;
export const IDBFS_MOUNT = "this.Vosk.FS.mount(this.Vosk.IDBFS, {}, storagePath);";
/** The IndexedDB database IDBFS uses — named after its mount point. */
export const VOSK_IDB_NAME = "/vosk";

export interface PatchedRuntime {
    source: string;
    /** true when the IndexedDB mount was removed */
    patched: boolean;
}

export function decodeWorkerSource(runtime: string): string | null {
    const match = WORKER_FACTORY.exec(runtime);
    return match ? atob(match[1]) : null;
}

export function patchRuntimeSource(runtime: string): PatchedRuntime {
    const match = WORKER_FACTORY.exec(runtime);
    if (!match) return { source: runtime, patched: false };

    // a binary string of the worker's UTF-8 bytes; the edit is pure ASCII, so it is safe here
    const worker = atob(match[1]);
    if (worker.split(IDBFS_MOUNT).length !== 2) return { source: runtime, patched: false };

    const patchedWorker = worker.replace(IDBFS_MOUNT, "/* MouthWash: model kept in worker memory only */");
    const source = runtime.slice(0, match.index)
        + `createBase64WorkerFactory('${btoa(patchedWorker)}'`
        + runtime.slice(match.index + match[0].length);

    return { source, patched: true };
}

/**
 * Evaluate the UMD bundle as CommonJS, so it returns its exports instead of setting a global.
 * Discord's CSP allows 'unsafe-eval'; blob: script URLs are not allowed for script-src.
 */
export function evaluateRuntime(source: string): any {
    const module = { exports: {} as any };

    new Function("exports", "module", "define", source)(module.exports, module, undefined);
    if (typeof module.exports.Model !== "function") throw new Error("The speech runtime did not load correctly.");
    return module.exports;
}
