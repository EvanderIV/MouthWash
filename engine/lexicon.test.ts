/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { cleanVocabulary, extractVocabulary, findTarEntry, LexiconError, readFstOutputSymbols, readWordsTxt } from "./lexicon";

/*
 * The last suite runs against the real model archive when MOUTHWASH_MODEL_ARCHIVE points at
 * vosk-model-small-en-us-0.15.tar.gz, and is skipped otherwise.
 */

// #region fixtures

function tarHeader(name: string, size: number, type = "0"): Uint8Array {
    const h = new Uint8Array(512);
    const enc = new TextEncoder();
    h.set(enc.encode(name).subarray(0, 100), 0);
    h.set(enc.encode("0000644\0"), 100);
    h.set(enc.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
    h[156] = type.charCodeAt(0);
    h.set(enc.encode("ustar\0"), 257);
    return h;
}

function tar(entries: { name: string; data: Uint8Array; type?: string; }[]): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const e of entries) {
        parts.push(tarHeader(e.name, e.data.length, e.type));
        const padded = new Uint8Array(Math.ceil(e.data.length / 512) * 512);
        padded.set(e.data);
        parts.push(padded);
    }
    parts.push(new Uint8Array(1024));
    return Buffer.concat(parts);
}

function fst(osymbols: string[], withIsymbols = true): Uint8Array {
    const chunks: Buffer[] = [];
    const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v); chunks.push(b); };
    const i64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); chunks.push(b); };
    const str = (s: string) => { const b = Buffer.from(s, "utf8"); i32(b.length); chunks.push(b); };
    const table = (syms: string[]) => {
        i32(2125658996);
        str("words.txt");
        i64(syms.length);
        i64(syms.length);
        syms.forEach((s, k) => { str(s); i64(k); });
    };

    i32(2125659606);
    str("ngram");
    str("standard");
    i32(4);
    i32(withIsymbols ? 3 : 2);
    i64(0); // properties
    i64(0);
    i64(1);
    i64(0);
    if (withIsymbols) table(osymbols);
    table(osymbols);
    chunks.push(Buffer.alloc(64)); // stand-in for the states that follow
    return Buffer.concat(chunks);
}

const streamOf = (bytes: Uint8Array, chunk = 333) => new ReadableStream<Uint8Array>({
    start(controller) {
        for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
        controller.close();
    }
});

const manyWords = Array.from({ length: 200 }, (_, i) => `word${i}`);

// #endregion

describe("findTarEntry", () => {
    const archive = tar([
        { name: "model/README", data: Buffer.from("hello") },
        { name: "model/graph/._Gr.fst", data: Buffer.from("apple double junk") },
        { name: "model/graph/Gr.fst", data: Buffer.from("the real one") }
    ]);

    it("finds an entry by its name relative to the model root", async () => {
        const entry = await findTarEntry(streamOf(archive), n => n === "graph/Gr.fst");
        assert.equal(Buffer.from(entry!.data).toString(), "the real one");
    });

    it("skips macOS AppleDouble files", async () => {
        const entry = await findTarEntry(streamOf(archive), n => n.endsWith("Gr.fst"));
        assert.equal(entry!.name, "model/graph/Gr.fst");
    });

    it("works regardless of how the stream is chunked", async () => {
        for (const chunk of [1, 7, 512, 100000]) {
            const entry = await findTarEntry(streamOf(archive, chunk), n => n === "README");
            assert.equal(Buffer.from(entry!.data).toString(), "hello", `chunk ${chunk}`);
        }
    });

    it("returns null when nothing matches", async () => {
        assert.equal(await findTarEntry(streamOf(archive), n => n === "nope"), null);
    });

    it("follows GNU long-name records", async () => {
        const longName = "model/" + "x".repeat(150) + "/graph/Gr.fst";
        const withLong = tar([
            { name: "././@LongLink", data: Buffer.from(longName + "\0"), type: "L" },
            { name: "truncated", data: Buffer.from("long") }
        ]);
        const entry = await findTarEntry(streamOf(withLong), n => n.endsWith("graph/Gr.fst"));
        assert.equal(entry?.name, longName);
    });

    it("rejects a truncated archive", async () => {
        const cut = archive.slice(0, 512 + 100);
        await assert.rejects(findTarEntry(streamOf(cut), n => n === "README"), LexiconError);
    });
});

describe("readFstOutputSymbols", () => {
    it("reads the embedded output symbols", () => {
        assert.deepEqual(readFstOutputSymbols(fst(["<eps>", "hello", "world"])), ["<eps>", "hello", "world"]);
    });

    it("works when only output symbols are embedded", () => {
        assert.deepEqual(readFstOutputSymbols(fst(["<eps>", "a"], false)), ["<eps>", "a"]);
    });

    it("rejects files that are not OpenFst", () => {
        assert.throws(() => readFstOutputSymbols(new Uint8Array(64)), LexiconError);
    });

    it("rejects a truncated header", () => {
        assert.throws(() => readFstOutputSymbols(fst(["<eps>", "hello"]).slice(0, 60)), LexiconError);
    });
});

describe("vocabulary helpers", () => {
    it("parses words.txt", () => {
        assert.deepEqual(readWordsTxt(Buffer.from("<eps> 0\nhello 1\r\nworld 2\n")), ["<eps>", "hello", "world"]);
    });

    it("drops decoder bookkeeping but keeps [unk]", () => {
        assert.deepEqual(cleanVocabulary(["<eps>", "!SIL", "#0", "[unk]", "like", "like"]), ["[unk]", "like"]);
    });
});

describe("extractVocabulary", () => {
    it("pulls the word list out of a gzipped model archive", async () => {
        const archive = gzipSync(tar([
            { name: "m/am/final.mdl", data: Buffer.alloc(2000) },
            { name: "m/graph/Gr.fst", data: fst(["<eps>", "[unk]", ...manyWords]) }
        ]));
        const words = await extractVocabulary(archive);
        assert.ok(words.includes("word42"));
        assert.ok(words.includes("[unk]"));
        assert.ok(!words.includes("<eps>"));
    });

    it("falls back to words.txt", async () => {
        const archive = gzipSync(tar([{ name: "m/graph/words.txt", data: Buffer.from(manyWords.map((w, i) => `${w} ${i}`).join("\n")) }]));
        assert.equal((await extractVocabulary(archive)).length, 200);
    });

    it("rejects an archive with no word list", async () => {
        await assert.rejects(extractVocabulary(gzipSync(tar([{ name: "m/README", data: Buffer.from("x") }]))), LexiconError);
    });
});

const realArchive = process.env.MOUTHWASH_MODEL_ARCHIVE;

describe("extractVocabulary — real vosk-model-small-en-us-0.15", { skip: !realArchive || !existsSync(realArchive) }, () => {
    it("finds the ~152k-word lexicon, including the words people actually want to quit", async () => {
        const words = new Set(await extractVocabulary(readFileSync(realArchive!)));
        assert.ok(words.size > 150_000, `only ${words.size} words`);
        for (const w of ["like", "literally", "basically", "fuck", "shit", "damn", "um", "[unk]"]) {
            assert.ok(words.has(w), `missing ${w}`);
        }
        assert.ok(!words.has("yeet"), "an out-of-vocabulary word should be absent");
    });
});
