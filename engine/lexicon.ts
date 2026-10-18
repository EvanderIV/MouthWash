/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Reads a Vosk model's vocabulary straight out of its .tar.gz, so phrases can be checked
 * against the lexicon before a grammar is ever built (§6.4).
 *
 * Small Vosk models ship no words.txt; the decoder takes its word list from the output symbol
 * table embedded in graph/Gr.fst. This module streams the archive through gunzip, keeps only
 * that one entry, and parses the OpenFst header to get the table.
 *
 * Pure: no Vencord/webpack/DOM imports. Uses only DecompressionStream, which both Chromium and
 * Node 18+ provide. See lexicon.test.ts.
 */

const FST_MAGIC = 2125659606;
const SYMBOL_TABLE_MAGIC = 2125658996;
const FST_HAS_ISYMBOLS = 1;
const FST_HAS_OSYMBOLS = 2;

/** Symbols that are decoder bookkeeping, never something a person says. */
const NON_WORDS = new Set(["<eps>", "!SIL", "<s>", "</s>", "<UNK>", "#0"]);

/** Entry names (relative to the model root) that can carry the vocabulary; first one in the archive wins. */
const VOCAB_SOURCES = ["graph/Gr.fst", "graph/words.txt", "words.txt"];

export class LexiconError extends Error { }

/** Gunzip a whole buffer as a stream of chunks. */
export function gunzipStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>;
}

function readOctal(header: Uint8Array, start: number, length: number): number {
    let value = 0;
    for (let i = start; i < start + length; i++) {
        const c = header[i];
        if (c === 0 || c === 0x20) {
            if (value) break;
            continue;
        }
        if (c < 0x30 || c > 0x37) break;
        value = value * 8 + (c - 0x30);
    }
    return value;
}

function readString(header: Uint8Array, start: number, length: number): string {
    let end = start;
    while (end < start + length && header[end] !== 0) end++;
    return new TextDecoder().decode(header.subarray(start, end));
}

/** Strip the archive's top-level folder: "vosk-model-small-en-us-0.15/graph/Gr.fst" → "graph/Gr.fst". */
function relativeName(name: string): string {
    const slash = name.indexOf("/");
    return slash === -1 ? name : name.slice(slash + 1);
}

/** macOS AppleDouble junk ("._Gr.fst") rides along in some archives. */
const isAppleDouble = (name: string) => /(^|\/)\._/.test(name);

/**
 * Stream a tar archive and return the bytes of the first regular-file entry whose relative name
 * `pick` accepts, or null. Only that entry is ever held in memory.
 */
export async function findTarEntry(
    stream: ReadableStream<Uint8Array>,
    pick: (relativeName: string) => boolean
): Promise<{ name: string; data: Uint8Array; } | null> {
    const reader = stream.getReader();

    // bytes received but not yet consumed
    let pending = new Uint8Array(0);
    let done = false;

    const need = async (n: number): Promise<boolean> => {
        while (pending.length < n && !done) {
            const { value, done: end } = await reader.read();
            if (end) {
                done = true;
                break;
            }
            const merged = new Uint8Array(pending.length + value.length);
            merged.set(pending);
            merged.set(value, pending.length);
            pending = merged;
        }
        return pending.length >= n;
    };

    /** Consume n bytes, returning them only if `keep`. Works across chunk boundaries. */
    const take = async (n: number, keep: boolean): Promise<Uint8Array | null> => {
        const out = keep ? new Uint8Array(n) : null;
        let got = 0;
        while (got < n) {
            if (!pending.length && !(await need(1))) throw new LexiconError("Model archive is truncated.");
            const step = Math.min(n - got, pending.length);
            out?.set(pending.subarray(0, step), got);
            pending = pending.subarray(step);
            got += step;
        }
        return out;
    };

    let longName: string | null = null;

    try {
        while (await need(512)) {
            const header = pending.subarray(0, 512);
            pending = pending.subarray(512);

            // two zero blocks end the archive; one is enough to stop looking
            if (header.every(b => b === 0)) return null;

            const size = readOctal(header, 124, 12);
            const type = String.fromCharCode(header[156] || 0x30);
            const padded = Math.ceil(size / 512) * 512;

            let name = readString(header, 0, 100);
            if (readString(header, 257, 5) === "ustar") {
                const prefix = readString(header, 345, 155);
                if (prefix) name = `${prefix}/${name}`;
            }
            if (longName) {
                name = longName;
                longName = null;
            }

            // GNU long-name record: the next entry's real name is this entry's content
            if (type === "L") {
                const data = await take(padded, true);
                longName = readString(data!, 0, size);
                continue;
            }

            const isFile = type === "0" || type === "\0";
            const wanted = isFile && !isAppleDouble(name) && pick(relativeName(name));

            if (wanted) {
                const data = await take(padded, true);
                return { name, data: data!.subarray(0, size) };
            }

            await take(padded, false);
        }

        return null;
    } finally {
        reader.cancel().catch(() => { });
    }
}

/** Read the output symbol table embedded in an OpenFst binary file. */
export function readFstOutputSymbols(fst: Uint8Array): string[] {
    const view = new DataView(fst.buffer, fst.byteOffset, fst.byteLength);
    const decoder = new TextDecoder();
    let offset = 0;

    const ensure = (n: number) => {
        if (offset + n > fst.byteLength) throw new LexiconError("FST header is truncated.");
    };
    const i32 = () => {
        ensure(4);
        const v = view.getInt32(offset, true);
        offset += 4;
        return v;
    };
    const i64 = () => {
        ensure(8);
        const v = Number(view.getBigInt64(offset, true));
        offset += 8;
        return v;
    };
    const str = () => {
        const length = i32();
        if (length < 0) throw new LexiconError("FST header is corrupt.");
        ensure(length);
        const s = decoder.decode(fst.subarray(offset, offset + length));
        offset += length;
        return s;
    };

    const readTable = (): string[] => {
        if (i32() !== SYMBOL_TABLE_MAGIC) throw new LexiconError("FST symbol table is corrupt.");
        str(); // table name
        i64(); // available key
        const size = i64();
        if (size < 0 || size > 10_000_000) throw new LexiconError("FST symbol table is corrupt.");

        const symbols: string[] = [];
        for (let i = 0; i < size; i++) {
            symbols.push(str());
            i64(); // key
        }
        return symbols;
    };

    if (i32() !== FST_MAGIC) throw new LexiconError("Not an OpenFst file.");
    str(); // fst type
    str(); // arc type
    i32(); // version
    const flags = i32();
    offset += 8; // properties
    i64(); // start state
    i64(); // number of states
    i64(); // number of arcs

    if (flags & FST_HAS_ISYMBOLS) readTable();
    if (!(flags & FST_HAS_OSYMBOLS)) throw new LexiconError("FST has no embedded word list.");

    return readTable();
}

/** Parse a Kaldi words.txt ("word id" per line). */
export function readWordsTxt(data: Uint8Array): string[] {
    return new TextDecoder()
        .decode(data)
        .split(/\r?\n/)
        .map(line => line.split(/\s+/)[0])
        .filter(Boolean);
}

/** Drop bookkeeping symbols and duplicates. `[unk]` is kept — grammars need it. */
export function cleanVocabulary(symbols: string[]): string[] {
    return [...new Set(symbols.filter(s => s && !NON_WORDS.has(s) && !s.startsWith("#")))];
}

/** Extract the vocabulary from a Vosk model .tar.gz. Throws LexiconError if it has none. */
export async function extractVocabulary(archive: Uint8Array): Promise<string[]> {
    const entry = await findTarEntry(gunzipStream(archive), name => VOCAB_SOURCES.includes(name));
    if (!entry) throw new LexiconError("The model archive has no word list.");

    const symbols = entry.name.endsWith(".fst") ? readFstOutputSymbols(entry.data) : readWordsTxt(entry.data);
    const words = cleanVocabulary(symbols);
    if (words.length < 100) throw new LexiconError("The model's word list is implausibly small.");

    return words;
}
