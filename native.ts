/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Everything that touches the disk. Runs in Electron's main process (§8.4).
 *
 *  - The model cache lives under userData/MouthWash/models/. Cache ids are validated to a flat
 *    file name, so the renderer can never name a path outside that folder.
 *  - Nothing here ever writes audio or transcript text. The only files written are the
 *    downloaded model archive, the speech runtime script, and the model's word list — all
 *    hash-verified by the renderer before it asks for them to be cached.
 *  - Custom sounds are read only if the path is an existing regular file with an audio
 *    extension and a sane size, so settings JSON cannot be used to read arbitrary files.
 */

import { ConnectSrc, CspPolicies } from "@main/csp";
import { app, BrowserWindow, dialog, IpcMainInvokeEvent } from "electron";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { extname, isAbsolute, join, normalize } from "path";

// Official vosk-browser model host. "*.github.io" is already allowlisted with connect-src for
// themes; this names the one host MouthWash actually downloads from, so the intent is explicit.
// The runtime comes from cdn.jsdelivr.net, which is allowlisted with script/worker/connect-src.
CspPolicies["ccoreilly.github.io"] ??= ConnectSrc;

const CACHE_ID = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".m4a", ".aac", ".webm"]);
const MAX_SOUND_BYTES = 10 * 1024 * 1024;
const MAX_CACHE_BYTES = 200 * 1024 * 1024;

const cacheDir = () => join(app.getPath("userData"), "MouthWash", "models");

function cachePath(id: string): string {
    if (typeof id !== "string" || !CACHE_ID.test(id) || id.includes("..")) {
        throw new Error(`Invalid cache id "${id}"`);
    }
    return join(cacheDir(), id);
}

/** Copy a Node Buffer into a standalone ArrayBuffer (Buffers can share a pooled backing store). */
const toArrayBuffer = (buf: Buffer): ArrayBuffer => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

export async function getCachedModel(_: IpcMainInvokeEvent, id: string): Promise<ArrayBuffer | null> {
    try {
        return toArrayBuffer(await readFile(cachePath(id)));
    } catch {
        return null;
    }
}

export async function cacheModel(_: IpcMainInvokeEvent, id: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const target = cachePath(id);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength > MAX_CACHE_BYTES) throw new Error("Refusing to cache an implausibly large file");

    await mkdir(cacheDir(), { recursive: true });

    // write-then-rename, so a crash mid-write never leaves a truncated file under the real name
    const temp = `${target}.partial`;
    await writeFile(temp, bytes);
    await rename(temp, target);
}

export async function clearModelCache(_: IpcMainInvokeEvent): Promise<void> {
    await rm(cacheDir(), { recursive: true, force: true });
}

export async function getModelCacheInfo(_: IpcMainInvokeEvent): Promise<{ path: string; files: { id: string; bytes: number; }[]; }> {
    const dir = cacheDir();
    const files: { id: string; bytes: number; }[] = [];

    try {
        for (const name of await readdir(dir)) {
            const info = await stat(join(dir, name)).catch(() => null);
            if (info?.isFile()) files.push({ id: name, bytes: info.size });
        }
    } catch {
        // no cache yet
    }

    return { path: dir, files };
}

function isAllowedSoundPath(path: unknown): path is string {
    return typeof path === "string"
        && path.length < 1024
        && !path.includes("\0")
        && isAbsolute(path)
        && AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

export async function readCustomSound(_: IpcMainInvokeEvent, path: string): Promise<ArrayBuffer | null> {
    if (!isAllowedSoundPath(path)) return null;

    try {
        const resolved = normalize(path);
        const info = await stat(resolved);
        if (!info.isFile() || info.size === 0 || info.size > MAX_SOUND_BYTES) return null;

        return toArrayBuffer(await readFile(resolved));
    } catch {
        return null;
    }
}

export async function pickCustomSound(event: IpcMainInvokeEvent): Promise<string | null> {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
        title: "Choose a MouthWash reaction sound",
        properties: ["openFile"],
        filters: [{ name: "Audio", extensions: [...AUDIO_EXTENSIONS].map(e => e.slice(1)) }]
    };

    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const path = result.canceled ? null : result.filePaths[0];

    return path && isAllowedSoundPath(path) ? path : null;
}
