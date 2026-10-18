/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Download, hash-verify and cache the Vosk runtime and model via the native module (§8.4, §8.5).
 *
 * Fetching executable weights (and a 5.8 MB WASM runtime) over the network is the one genuinely
 * dangerous thing this plugin does, so both are pinned by SHA-256 and size. Bytes are verified
 * when downloaded *and* every time they are loaded from the disk cache — a file that does not
 * match its pin is never handed to the runtime, whatever its origin.
 *
 * This is the only network access in the plugin, and it only ever happens when the user presses
 * the download button.
 */

import { PluginNative } from "@utils/types";

import { extractVocabulary } from "./lexicon";

const Native = VencordNative.pluginHelpers.MouthWash as PluginNative<typeof import("../native")>;

export interface PinnedAsset {
    /** flat file name in the cache folder */
    cacheId: string;
    url: string;
    host: string;
    sha256: string;
    bytes: number;
}

export interface ModelInfo {
    id: string;
    label: string;
    language: string;
    archive: PinnedAsset;
}

/** vosk-browser's UMD bundle: the Vosk WASM build plus its recognition worker, inlined. */
export const RUNTIME: PinnedAsset = {
    cacheId: "vosk-browser-0.0.8.js",
    url: "https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js",
    host: "cdn.jsdelivr.net",
    sha256: "29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c",
    bytes: 5_804_767
};

/**
 * Models MouthWash knows the hashes of. The architecture allows other Vosk models, but only a
 * pinned one can ever be loaded, and v1 ships English only (§3).
 */
export const MODELS: Record<string, ModelInfo> = {
    "vosk-model-small-en-us-0.15": {
        id: "vosk-model-small-en-us-0.15",
        label: "English (US), small",
        language: "en-US",
        archive: {
            cacheId: "vosk-model-small-en-us-0.15.tar.gz",
            url: "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz",
            host: "ccoreilly.github.io",
            sha256: "f0b24bb92a48ca575b6a96500d6b543f0f079c573dfe85bbe16001fc0404e1d8",
            bytes: 41_184_862
        }
    }
};

export const DEFAULT_MODEL_ID = "vosk-model-small-en-us-0.15";

const vocabCacheId = (model: ModelInfo) => `${model.id}.vocab.txt`;

export class ModelError extends Error { }
export class ModelMissingError extends ModelError { }
export class HashMismatchError extends ModelError { }

export function getModel(id: string): ModelInfo {
    const model = MODELS[id];
    if (!model) throw new ModelError(`Unknown model "${id}". Only models with a pinned hash can be loaded.`);
    return model;
}

export const formatMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verify(asset: PinnedAsset, data: ArrayBuffer | Uint8Array): Promise<void> {
    if (data.byteLength !== asset.bytes) {
        throw new HashMismatchError(`${asset.cacheId} is ${data.byteLength} bytes, expected ${asset.bytes}. It will not be loaded.`);
    }
    const actual = await sha256Hex(data);
    if (actual !== asset.sha256) {
        throw new HashMismatchError(`${asset.cacheId} does not match its pinned SHA-256 (got ${actual.slice(0, 12)}…). It will not be loaded.`);
    }
}

/** Whether the runtime and model are on disk with the right sizes. Cheap: does not hash. */
export async function isBundleCached(modelId: string): Promise<boolean> {
    const model = getModel(modelId);
    const { files } = await Native.getModelCacheInfo();
    const has = (a: PinnedAsset) => files.some(f => f.id === a.cacheId && f.bytes === a.bytes);
    return has(RUNTIME) && has(model.archive);
}

export const totalDownloadBytes = (modelId: string) => RUNTIME.bytes + getModel(modelId).archive.bytes;

async function fetchVerified(asset: PinnedAsset, onBytes: (received: number) => void, signal: AbortSignal): Promise<Uint8Array> {
    const res = await fetch(asset.url, { signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok || !res.body) throw new ModelError(`Downloading from ${asset.host} failed (HTTP ${res.status}).`);

    const data = new Uint8Array(asset.bytes);
    const reader = res.body.getReader();
    let received = 0;

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (received + value.length > asset.bytes) {
                throw new HashMismatchError(`${asset.host} sent more data than the pinned ${asset.cacheId} — refusing it.`);
            }
            data.set(value, received);
            received += value.length;
            onBytes(received);
        }
    } finally {
        reader.cancel().catch(() => { });
    }

    await verify(asset, received === asset.bytes ? data : data.subarray(0, received));
    return data;
}

export interface DownloadProgress {
    phase: string;
    /** 0..1 across the whole bundle */
    fraction: number;
}

/**
 * Download whatever is missing (runtime and/or model), verify each against its pin, extract the
 * model's word list, and cache all of it. Nothing unverified is ever written.
 */
export async function downloadBundle(modelId: string, onProgress: (p: DownloadProgress) => void, signal: AbortSignal): Promise<void> {
    const model = getModel(modelId);
    const { files } = await Native.getModelCacheInfo();
    const cached = (a: PinnedAsset) => files.some(f => f.id === a.cacheId && f.bytes === a.bytes);

    const assets = [RUNTIME, model.archive].filter(a => !cached(a));
    const total = assets.reduce((n, a) => n + a.bytes, 0) || 1;
    let done = 0;

    for (const asset of assets) {
        const label = asset === RUNTIME ? "speech runtime" : "speech model";
        const data = await fetchVerified(asset, received => onProgress({ phase: `Downloading ${label} from ${asset.host}`, fraction: (done + received) / total }), signal);

        if (asset === model.archive) {
            onProgress({ phase: "Reading the model's vocabulary", fraction: (done + asset.bytes) / total });
            const vocab = await extractVocabulary(data);
            await Native.cacheModel(vocabCacheId(model), new TextEncoder().encode(vocab.join("\n")));
        }

        onProgress({ phase: `Saving ${label}`, fraction: (done + asset.bytes) / total });
        await Native.cacheModel(asset.cacheId, data);
        done += asset.bytes;
    }

    onProgress({ phase: "Done", fraction: 1 });
}

export interface LoadedBundle {
    runtimeSource: string;
    model: ArrayBuffer;
    vocabulary: Set<string>;
}

async function readVerified(asset: PinnedAsset): Promise<ArrayBuffer> {
    const data = await Native.getCachedModel(asset.cacheId);
    if (!data) throw new ModelMissingError(`${asset.cacheId} is not downloaded.`);
    await verify(asset, data);
    return data;
}

/** Read the cached bundle, verifying every byte against its pin first. */
export async function loadBundle(modelId: string): Promise<LoadedBundle> {
    const model = getModel(modelId);

    const [runtime, archive] = await Promise.all([readVerified(RUNTIME), readVerified(model.archive)]);

    let words: string[];
    const cachedVocab = await Native.getCachedModel(vocabCacheId(model));
    if (cachedVocab) {
        words = new TextDecoder().decode(cachedVocab).split("\n").filter(Boolean);
    } else {
        // derived from the verified archive, so it is as trustworthy as the archive itself
        words = await extractVocabulary(new Uint8Array(archive));
        await Native.cacheModel(vocabCacheId(model), new TextEncoder().encode(words.join("\n")));
    }

    return {
        runtimeSource: new TextDecoder().decode(runtime),
        model: archive,
        vocabulary: new Set(words)
    };
}

export async function clearCache(): Promise<void> {
    await Native.clearModelCache();
}

export async function getCacheInfo() {
    return Native.getModelCacheInfo();
}
