/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Vosk host: loads the verified runtime and model, builds and rebuilds the restricted grammar
 * (§6.3, §6.4), and forwards results.
 *
 * Recognition runs in vosk-browser's own Web Worker — the WASM decoder never touches Discord's
 * main thread (§8.1). That worker ships inlined in the pinned runtime bundle, which is why
 * there is no separate engine/worker.ts.
 */

import { logOnce } from "../fluxEvents";
import type { EngineCallbacks, PhraseUpdate, RecognitionEngine } from ".";
import { loadBundle } from "./modelCache";
import { evaluateRuntime, patchRuntimeSource, VOSK_IDB_NAME } from "./voskRuntime";

const SAMPLE_RATE = 16000;
const LOAD_TIMEOUT_MS = 180_000;
/** how long a new recognizer gets to report a construction error before it counts as good */
const PROBE_TIMEOUT_MS = 8000;

function deleteVoskDatabase(): void {
    try {
        indexedDB.deleteDatabase(VOSK_IDB_NAME);
    } catch { }
}

function loadModel(Vosk: any, url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const model = new Vosk.Model(url);
        const { worker } = model;

        const timer = setTimeout(() => fail(new Error("Loading the speech model timed out.")), LOAD_TIMEOUT_MS);
        const fail = (e: Error) => {
            clearTimeout(timer);
            try {
                model.terminate();
                worker?.terminate();
            } catch { }
            reject(e);
        };

        model.on("load", (m: any) => {
            clearTimeout(timer);
            if (m?.result) resolve(model);
            else fail(new Error("The speech model failed to load."));
        });
        model.on("error", (m: any) => fail(new Error(`The speech model failed to load: ${m?.error ?? "unknown error"}`)));
        worker?.addEventListener("error", e => fail(new Error(`The speech worker crashed while loading: ${e.message || "unknown error"}`)));
    });
}

/** Phrases whose every word is in the model's lexicon (§6.4). */
export function checkLexicon(phrases: string[], vocabulary: Set<string>): PhraseUpdate {
    const accepted: string[] = [];
    const rejected: PhraseUpdate["rejected"] = [];

    for (const phrase of phrases) {
        const missing = phrase.split(" ").filter(word => !vocabulary.has(word));
        if (missing.length) {
            rejected.push({
                phrase,
                reason: `${missing.map(w => `"${w}"`).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in the speech model's vocabulary`
            });
        } else {
            accepted.push(phrase);
        }
    }

    return { accepted, rejected };
}

export class VoskEngine implements RecognitionEngine {
    readonly kind = "vosk" as const;
    readonly consumesFrames = true;

    private recognizer: any = null;
    private grammarKey: string | null = null;
    /** vocabulary-checked variant forms added to the current grammar */
    private grammarExtras: string[] = [];
    private disposed = false;
    private rebuild: Promise<PhraseUpdate> = Promise.resolve({ accepted: [], rejected: [] });

    private constructor(
        private readonly model: any,
        private readonly vocabulary: Set<string>,
        private readonly callbacks: EngineCallbacks,
        private readonly modelId: string,
        private readonly usesIndexedDB: boolean
    ) {
        model.worker?.addEventListener("error", (e: ErrorEvent) => {
            if (!this.disposed) this.callbacks.onCrash(`The speech worker crashed: ${e.message || "unknown error"}`);
        });
        model.on("error", (m: any) => logOnce(`vosk-model-error:${m?.error}`, `Vosk error: ${m?.error}`));
    }

    get label(): string {
        return `Vosk, model ${this.modelId}`;
    }

    /** Verify, load and start the model. Throws ModelMissingError / HashMismatchError from the cache. */
    static async create(modelId: string, callbacks: EngineCallbacks): Promise<VoskEngine> {
        const bundle = await loadBundle(modelId);

        const { source, patched } = patchRuntimeSource(bundle.runtimeSource);
        if (!patched) logOnce("vosk-patch", "Could not keep the Vosk model out of IndexedDB; it will be deleted around each load instead");

        const Vosk = evaluateRuntime(source);
        if (!patched) deleteVoskDatabase();

        const url = URL.createObjectURL(new Blob([bundle.model], { type: "application/gzip" }));
        try {
            const model = await loadModel(Vosk, url);
            return new VoskEngine(model, bundle.vocabulary, callbacks, modelId, !patched);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    setPhrases(phrases: string[], restrictedGrammar: boolean, variants: string[] = []): Promise<PhraseUpdate> {
        // serialise rebuilds so two quick edits cannot race each other's recognizers
        this.rebuild = this.rebuild.catch(() => null).then(() => this.applyPhrases(phrases, restrictedGrammar, variants));
        return this.rebuild;
    }

    private async applyPhrases(phrases: string[], restrictedGrammar: boolean, variants: string[]): Promise<PhraseUpdate> {
        const { accepted, rejected } = checkLexicon(phrases, this.vocabulary);

        // the open vocabulary already contains every form it knows; only a grammar needs them listed
        this.grammarExtras = restrictedGrammar
            ? checkLexicon(variants, this.vocabulary).accepted.filter(v => !accepted.includes(v))
            : [];

        const key = `${restrictedGrammar ? "g" : "open"}:${[...accepted].sort().join("|")}+${[...this.grammarExtras].sort().join("|")}`;
        if (key === this.grammarKey) return { accepted, rejected };

        if (!accepted.length) {
            this.replaceRecognizer(null);
            this.grammarKey = key;
            return { accepted, rejected };
        }

        let usable = accepted;
        const extras = this.grammarExtras;
        let recognizer = await this.tryBuild(usable, restrictedGrammar, extras);

        // the optional variants must never cost a word: if they break the grammar, drop them
        if (!recognizer && extras.length) {
            logOnce("vosk-extras", "The grammar was refused with plural forms added; building it without them");
            recognizer = await this.tryBuild(usable, restrictedGrammar);
        }

        if (!recognizer && restrictedGrammar) {
            // The whole grammar was refused. Find the offenders one phrase at a time, disable
            // only those, and keep the rest working (§6.4).
            const bad: string[] = [];
            for (const phrase of accepted) {
                const alone = await this.tryBuild([phrase], true);
                if (alone) alone.remove();
                else bad.push(phrase);
            }

            for (const phrase of bad) rejected.push({ phrase, reason: "the speech model refused it" });
            usable = accepted.filter(p => !bad.includes(p));
            recognizer = usable.length ? await this.tryBuild(usable, true) : null;
        }

        if (this.disposed) {
            recognizer?.remove();
            return { accepted: usable, rejected };
        }

        if (usable.length && !recognizer) {
            // nothing could be built at all — report every phrase rather than pretend
            for (const phrase of usable) rejected.push({ phrase, reason: "the speech recognizer could not be built" });
            usable = [];
        }

        this.replaceRecognizer(recognizer);
        this.grammarKey = key;
        return { accepted: usable, rejected };
    }

    /** Build a recognizer and confirm the worker accepted it. Resolves null if it was refused. */
    private tryBuild(phrases: string[], restrictedGrammar: boolean, extras: string[] = []): Promise<any | null> {
        return new Promise(resolve => {
            let recognizer: any;
            try {
                const grammar = restrictedGrammar ? JSON.stringify([...phrases, ...extras, "[unk]"]) : undefined;
                recognizer = new this.model.KaldiRecognizer(SAMPLE_RATE, grammar);
            } catch (e) {
                logOnce(`vosk-build:${phrases.join("|")}`, "Recognizer construction threw", e);
                resolve(null);
                return;
            }

            let settled = false;
            const settle = (ok: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (!ok) {
                    try {
                        recognizer.remove();
                    } catch { }
                }
                resolve(ok ? recognizer : null);
            };

            // Creation is asynchronous in the worker and only reports failure. Ask for a final
            // result straight after: a "result" means the recognizer exists, an "error" means
            // it was refused. The worker handles messages in order.
            recognizer.on("error", () => settle(false));
            recognizer.on("result", () => settle(true));
            const timer = setTimeout(() => settle(true), PROBE_TIMEOUT_MS);

            try {
                recognizer.setWords(true); // per-word confidences in final results (§6.5)
                recognizer.retrieveFinalResult();
            } catch {
                settle(false);
            }
        });
    }

    private replaceRecognizer(next: any | null) {
        const previous = this.recognizer;
        this.recognizer = next;

        if (next) {
            next.on("partialresult", (m: any) => {
                if (this.recognizer === next) this.callbacks.onPartial(m?.result?.partial ?? "");
            });
            next.on("result", (m: any) => {
                if (this.recognizer !== next) return;
                const result = m?.result ?? {};
                this.callbacks.onFinal({
                    text: result.text ?? "",
                    words: Array.isArray(result.result)
                        ? result.result.map((w: any) => ({
                            word: String(w.word ?? ""),
                            conf: typeof w.conf === "number" ? w.conf : null,
                            start: typeof w.start === "number" ? w.start : undefined,
                            end: typeof w.end === "number" ? w.end : undefined
                        }))
                        : []
                });
            });
        }

        try {
            previous?.remove();
        } catch { }
    }

    attach(): void { }

    detach(): void {
        this.endUtterance();
    }

    acceptFrame(samples: Float32Array): void {
        try {
            // acceptWaveformFloat copies (scaling to int16 range) and transfers the copy
            this.recognizer?.acceptWaveformFloat(samples, SAMPLE_RATE);
        } catch (e) {
            logOnce("vosk-accept", "Could not pass audio to the recognizer", e);
        }
    }

    endUtterance(): void {
        try {
            this.recognizer?.retrieveFinalResult();
        } catch { }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        try {
            this.recognizer?.remove();
        } catch { }
        this.recognizer = null;

        try {
            this.model.terminate();
        } catch { }
        // terminate() only asks politely; make sure the worker and its WASM heap are gone (§8.3)
        try {
            this.model.worker?.terminate();
        } catch { }

        if (this.usesIndexedDB) deleteVoskDatabase();
    }
}
