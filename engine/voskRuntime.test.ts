/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { decodeWorkerSource, IDBFS_MOUNT, patchRuntimeSource } from "./voskRuntime";

/*
 * The last suite runs against the real vosk-browser 0.0.8 bundle when MOUTHWASH_VOSK_RUNTIME
 * points at its dist/vosk.js, and is skipped otherwise.
 */

const fakeRuntime = (worker: string) =>
    `var a = 1;\nvar WorkerFactory = createBase64WorkerFactory('${btoa(worker)}', null, false);\nvar b = 2;`;

describe("patchRuntimeSource", () => {
    it("removes the IndexedDB mount from the inlined worker", () => {
        const { source, patched } = patchRuntimeSource(fakeRuntime(`load() {\n${IDBFS_MOUNT}\nsync(); }`));
        assert.equal(patched, true);
        const worker = decodeWorkerSource(source)!;
        assert.ok(!worker.includes("IDBFS"));
        assert.ok(worker.includes("sync();"));
        assert.ok(source.startsWith("var a = 1;") && source.endsWith("var b = 2;"));
    });

    it("leaves the bundle alone when the line is missing", () => {
        const runtime = fakeRuntime("load() { somethingElse(); }");
        assert.deepEqual(patchRuntimeSource(runtime), { source: runtime, patched: false });
    });

    it("leaves the bundle alone when the line is ambiguous", () => {
        const runtime = fakeRuntime(`${IDBFS_MOUNT}\n${IDBFS_MOUNT}`);
        assert.equal(patchRuntimeSource(runtime).patched, false);
    });

    it("leaves non-vosk input alone", () => {
        assert.equal(patchRuntimeSource("console.log(1)").patched, false);
    });
});

const realRuntime = process.env.MOUTHWASH_VOSK_RUNTIME;

describe("patchRuntimeSource — real vosk-browser 0.0.8", { skip: !realRuntime || !existsSync(realRuntime) }, () => {
    it("patches the pinned bundle and keeps everything else intact", () => {
        const original = readFileSync(realRuntime!, "utf8");
        const { source, patched } = patchRuntimeSource(original);
        assert.equal(patched, true);

        const before = decodeWorkerSource(original)!;
        const after = decodeWorkerSource(source)!;
        assert.ok(before.includes(IDBFS_MOUNT));
        assert.ok(!after.includes("FS.mount(this.Vosk.IDBFS"));
        // only that one line changed
        assert.equal(after.length - before.length, "/* MouthWash: model kept in worker memory only */".length - IDBFS_MOUNT.length);
        assert.ok(after.includes("downloadAndExtract"));
    });
});
