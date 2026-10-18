/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Settings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { ExpandableSection } from "@components/ExpandableCard";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { HeadingSecondary } from "@components/Heading";
import { ErrorBoundary } from "@components/index";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { Switch } from "@components/Switch";
import { classNameFactory } from "@utils/css";
import { PluginNative } from "@utils/types";
import { Select, Slider, TextInput, useCallback, useEffect, useReducer, useState } from "@webpack/common";

import { isVirtualDevice, listInputDevices, listOutputDevices } from "./audio/devices";
import {
    cancelDownload,
    downloadModel,
    onWordsChanged,
    reevaluateGate,
    reloadEngine,
    retryEngine,
    setListening,
    testReaction
} from "./controller";
import { FINAL_ONLY_THRESHOLD, isFinalOnly, normalizePhrase, phraseError, phraseVariants } from "./detection";
import { clearCache, formatMB, getCacheInfo, getModel, MODELS, RUNTIME } from "./engine/modelCache";
import type { GateCheck } from "./gate";
import { PRESET_SOUND_IDS, PRESET_SOUNDS } from "./presetSounds";
import { reactionPlayer } from "./reaction";
import { settings } from "./settings";
import { forgetWord, getLastDetection, getSessionStats, getSessionTotals, resetSession, subscribeStats } from "./stats";
import { type BannerAction, getLevel, getStatus, subscribeLevel, subscribeStatus, useSubscription } from "./status";
import type { EngineChoice, ReactionConfig, ReactionKind, TargetWord, TransmitSource } from "./types";
import { effectiveReaction, makeReaction, makeWord, MAX_COOLDOWN_MS, normalizeWordList, phrasesFromVariableFilter } from "./words";

const Native = VencordNative.pluginHelpers.MouthWash as PluginNative<typeof import("./native")>;
const cl = classNameFactory("vc-mw-");
const subscribeOutput = (listener: () => void) => reactionPlayer.subscribeOutput(listener);
const newId = () => crypto.randomUUID();

/**
 * Nested mutations of the settings arrays do not fire the exact-path listeners that
 * `settings.use` subscribes to, so edits re-render through an explicit force update.
 */
function useForceUpdate() {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
    return forceUpdate as () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode; }) {
    return (
        <div className={cl("field")}>
            <Span size="sm" weight="medium" className={cl("field-label")}>{label}</Span>
            {children}
        </div>
    );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(v: T): void; }) {
    return (
        <div className={cl("segmented")}>
            {options.map(([key, text]) => (
                <Button key={key} size="small" variant={value === key ? "primary" : "secondary"} onClick={() => onChange(key)}>
                    {text}
                </Button>
            ))}
        </div>
    );
}

function relativeTime(at: number): string {
    const s = Math.round((Date.now() - at) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    return new Date(at).toLocaleTimeString();
}

function pluralDescription(phrase: string): string {
    const forms = phraseVariants(phrase, true).filter(v => v !== phrase);
    const shown = forms.length ? forms.map(f => `"${f}"`).join(", ") : "its plural";
    return `Also reacts to ${shown}. Other forms like "-ing" or "-ed" aren't included; add them as their own words if you want them.`;
}

const thresholdLabel = (t: number) =>
    isFinalOnly(t) ? "strict · final-only" : t < 0.5 ? "twitchy" : t < 0.8 ? "balanced" : "strict";

// #region status

function LevelMeter() {
    useSubscription(subscribeLevel);
    const rms = getLevel();
    // map -60..0 dBFS onto the bar
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));

    return (
        <div className={cl("meter")} title={`${db.toFixed(0)} dBFS`}>
            <div className={cl("meter-fill")} style={{ width: `${pct}%` }} />
        </div>
    );
}

function CheckRow({ check }: { check: GateCheck; }) {
    const icon = check.ok ? "✓" : check.required ? "✗" : "–";
    return (
        <span className={cl("check", check.ok ? "check-ok" : check.required ? "check-fail" : "check-skip")} title={check.required ? undefined : "Not required (Advanced)"}>
            {check.label} {icon}
        </span>
    );
}

function bannerButton(action: BannerAction | undefined) {
    switch (action) {
        case "retryEngine":
            return <Button size="small" onClick={retryEngine}>Retry</Button>;
        case "downloadModel":
            return <Button size="small" onClick={() => void downloadModel()}>Download again</Button>;
        case "enableListening":
            return <Button size="small" onClick={() => setListening(true)}>Try again</Button>;
        default:
            return null;
    }
}

function ModelDownloadPrompt() {
    const status = getStatus();
    const model = getModel(settings.store.modelId);
    const downloading = status.engineState === "downloading";

    return (
        <Card variant="info" className={cl("download")}>
            <HeadingSecondary>One-time speech model download</HeadingSecondary>
            <Paragraph>
                This client has no on-device speech recognition, so MouthWash uses Vosk, which runs entirely on your
                computer. It needs a one-time download, cached locally and never fetched again:
            </Paragraph>
            <ul className={cl("list")}>
                <li><b>{model.label} speech model</b> — {formatMB(model.archive.bytes)} from <code>{model.archive.host}</code></li>
                <li><b>Vosk speech runtime</b> — {formatMB(RUNTIME.bytes)} from <code>{RUNTIME.host}</code></li>
            </ul>
            <Paragraph className={cl("hint")}>
                Both are checked against pinned SHA-256 hashes before they are saved, and again every time they load. Nothing
                about you is sent: these are plain file downloads. Until you accept, MouthWash stays switched off.
            </Paragraph>

            {downloading
                ? (
                    <div className={cl("progress-wrap")}>
                        <div className={cl("progress")}>
                            <div className={cl("progress-fill")} style={{ width: `${Math.round((status.downloadProgress ?? 0) * 100)}%` }} />
                        </div>
                        <Span size="sm" className={cl("hint")}>
                            {status.downloadPhase} — {Math.round((status.downloadProgress ?? 0) * 100)}%
                        </Span>
                        <Button size="small" variant="secondary" onClick={cancelDownload}>Cancel</Button>
                    </div>
                )
                : <Button onClick={() => void downloadModel()}>Download {formatMB(model.archive.bytes + RUNTIME.bytes)}</Button>}
        </Card>
    );
}

function StatusPanel() {
    useSubscription(subscribeStatus);
    useSubscription(subscribeStats);
    const { listening } = settings.use(["listening"]);

    // keep "x seconds ago" fresh
    const forceUpdate = useForceUpdate();
    useEffect(() => {
        const timer = setInterval(forceUpdate, 5000);
        return () => clearInterval(timer);
    }, [forceUpdate]);

    const status = getStatus();
    const { gate } = status;
    const last = getLastDetection();
    const listeningNow = status.captureState === "open" && !!gate?.feeding;

    let summary: string;
    useSubscription(subscribeOutput);

    if (!listening) summary = "Listening is switched off";
    else if (status.engineState === "needsModel" || status.engineState === "downloading") summary = "Waiting for the speech model";
    else if (status.engineState === "unavailable" || status.engineState === "error") summary = "Not listening — speech engine unavailable";
    else if (listeningNow) summary = "Listening";
    else if (gate?.blockedBy) summary = `Not listening — ${gate.blockedBy.label.toLowerCase()} ✗`;
    else if (status.captureState === "opening" || status.engineState === "loading") summary = "Starting…";
    else summary = "Idle";

    return (
        <section className={cl("status")}>
            {status.banner && (
                <Card variant="danger" className={cl("banner")}>
                    <Paragraph>{status.banner.message}</Paragraph>
                    {bannerButton(status.banner.action)}
                </Card>
            )}

            {status.warning && (
                <Card variant="warning" className={cl("banner")}>
                    <Paragraph>{status.warning}</Paragraph>
                </Card>
            )}

            <Card className={cl("status-card")}>
                <div className={cl("status-head")}>
                    <span className={cl("dot", listeningNow ? "dot-on" : status.captureState === "open" ? "dot-idle" : "dot-off")} />
                    <Span weight="semibold" size="md">{summary}</Span>
                    <div className={cl("status-switch")}>
                        <Span size="sm" className={cl("hint")}>Listening</Span>
                        <Switch checked={listening} onChange={setListening} />
                    </div>
                </div>

                {gate && (
                    <div className={cl("checks")}>
                        {gate.checks.filter(c => c.id !== "dm" || !c.ok).map(c => <CheckRow key={c.id} check={c} />)}
                    </div>
                )}

                {status.captureState === "open" && (
                    <Field label={`Input level · ${status.captureDevice ?? "microphone"}`}>
                        <LevelMeter />
                    </Field>
                )}

                <div className={cl("status-lines")}>
                    <Span size="sm"><b>Engine:</b> {status.engineLabel}{status.engineState === "loading" ? " (loading…)" : ""}</Span>
                    {status.engineDetail && <Span size="sm" className={cl("hint")}>{status.engineDetail}</Span>}
                    {status.captureState === "open" && (
                        <Span size="sm" className={reactionPlayer.outputIsVirtual ? cl("warn") : undefined}>
                            <b>Reactions play on:</b> {reactionPlayer.output}
                            {reactionPlayer.outputIsVirtual && " — a virtual device; see Reaction below"}
                        </Span>
                    )}
                    <Span size="sm">
                        <b>Last detection:</b>{" "}
                        {last ? <>“{last.phrase}” · {relativeTime(last.at)}{last.fired ? "" : " (cooldown, no sound)"}</> : "none this session"}
                    </Span>
                </div>

                <Paragraph className={cl("privacy")}>
                    🔒 Audio is processed on this device and never leaves it. Nothing is recorded.
                </Paragraph>
            </Card>

            {(status.engineState === "needsModel" || status.engineState === "downloading") && <ModelDownloadPrompt />}
        </section>
    );
}

// #endregion

// #region reactions

const KIND_OPTIONS: [ReactionKind, string][] = [
    ["buzzer", "Buzzer"],
    ["preset", "Sound clip"],
    ["beep", "Beep"],
    ["customSound", "Your file"],
    ["tts", "Speak"],
    ["toast", "Toast only"],
    ["silent", "Silent"]
];

function ReactionEditor({ reaction, phrase, onChanged }: { reaction: ReactionConfig; phrase: string; onChanged(): void; }) {
    const update = <K extends keyof ReactionConfig>(key: K, value: ReactionConfig[K]) => {
        reaction[key] = value;
        onChanged();
    };

    const hasSound = !["toast", "silent"].includes(reaction.kind);
    const fileName = reaction.soundPath?.split(/[\\/]/).pop();

    return (
        <div className={cl("reaction")}>
            <Segmented
                value={reaction.kind}
                options={KIND_OPTIONS}
                onChange={kind => {
                    update("kind", kind);
                    if (kind === "preset" && !reaction.preset) update("preset", PRESET_SOUND_IDS[0]);
                }}
            />

            {reaction.kind === "preset" && (
                <Segmented
                    value={reaction.preset ?? PRESET_SOUND_IDS[0]}
                    options={PRESET_SOUND_IDS.map(id => [id, PRESET_SOUNDS[id].label])}
                    onChange={id => update("preset", id)}
                />
            )}

            {reaction.kind === "customSound" && (
                <Flex style={{ gap: "0.5em", alignItems: "center" }}>
                    <Button
                        size="small"
                        variant="secondary"
                        onClick={async () => {
                            const path = await Native.pickCustomSound();
                            if (path) update("soundPath", path);
                        }}
                    >
                        Choose sound file…
                    </Button>
                    <Span size="sm" className={cl("hint")} title={reaction.soundPath}>
                        {fileName ?? "No file chosen — a beep plays instead"}
                    </Span>
                </Flex>
            )}

            {reaction.kind === "tts" && (
                <Field label="What to say">
                    <TextInput
                        value={reaction.ttsText ?? ""}
                        placeholder={`you said ${phrase || "it"}`}
                        onChange={(v: string) => update("ttsText", v)}
                    />
                    <Span size="sm" className={cl("hint")}>
                        Uses an on-device voice only, and plays on your system's default output rather than Discord's.
                    </Span>
                </Field>
            )}

            {hasSound && (
                <Field label={`Volume · ${Math.round(reaction.volume * 100)}%`}>
                    <Slider
                        markers={[0, 0.25, 0.5, 0.75, 1]}
                        minValue={0}
                        maxValue={1}
                        initialValue={reaction.volume}
                        stickToMarkers={false}
                        onValueChange={(v: number) => update("volume", Math.round(v * 100) / 100)}
                        onValueRender={(v: number) => `${Math.round(v * 100)}%`}
                        onMarkerRender={(v: number) => `${v * 100}%`}
                    />
                </Field>
            )}

            <Flex style={{ gap: "0.75em", alignItems: "center", flexWrap: "wrap" }}>
                <Button className={cl("preview")} onClick={() => void testReaction(reaction, phrase)}>
                    ▶ Test this reaction
                </Button>
                <label className={cl("inline-switch")}>
                    <Switch checked={reaction.alsoToast} onChange={v => update("alsoToast", v)} />
                    <Span size="sm">Also show a toast naming the word</Span>
                </label>
            </Flex>
        </div>
    );
}

function DefaultReactionSection({ onChanged }: { onChanged(): void; }) {
    const reaction = settings.store.defaultReaction;
    const observing = reaction.kind === "silent";
    const [previous, setPrevious] = useState<ReactionKind>("buzzer");

    return (
        <section>
            <HeadingSecondary>Reaction</HeadingSecondary>
            <Paragraph>
                What happens when a word is caught. It plays only in your own output — never into the call. Use
                headphones: on open speakers your mic can pick up a loud buzz like any other sound.
            </Paragraph>

            <Card variant={observing ? "success" : "info"} className={cl("observe")}>
                <FormSwitch
                    title="Observe mode (recommended to start)"
                    description={
                        "Count hits silently for a session, then tune each word's threshold from real numbers before turning " +
                        "the buzzer on. Guessing thresholds blind with a loud buzzer is a bad first experience. " +
                        "Words with their own reaction override still play it."
                    }
                    value={observing}
                    hideBorder
                    onChange={on => {
                        if (on) {
                            setPrevious(reaction.kind === "silent" ? "buzzer" : reaction.kind);
                            reaction.kind = "silent";
                        } else {
                            reaction.kind = previous;
                        }
                        onChanged();
                    }}
                />
            </Card>

            <OutputDevicePicker />
            <ReactionEditor reaction={reaction} phrase="" onChanged={onChanged} />
        </section>
    );
}

// #endregion

// #region words

function WordEditor({ word, onChanged, onDelete }: { word: TargetWord; onChanged(): void; onDelete(): void; }) {
    useSubscription(subscribeStats);
    useSubscription(subscribeStatus);

    const update = <K extends keyof TargetWord>(key: K, value: TargetWord[K]) => {
        word[key] = value;
        onChanged();
    };

    const session = getSessionStats(word.id);
    const rejected = getStatus().rejected[word.id];
    const reaction = effectiveReaction(word, settings.store.defaultReaction);

    return (
        <div className={cl("editor")}>
            {rejected && <Paragraph className={cl("error")}>Disabled: {rejected}. Try a different spelling or word.</Paragraph>}

            <Field label={`Sensitivity · ${word.threshold.toFixed(2)} (${thresholdLabel(word.threshold)})`}>
                <Slider
                    markers={[0, 0.25, 0.5, 0.75, FINAL_ONLY_THRESHOLD, 1]}
                    minValue={0}
                    maxValue={1}
                    initialValue={word.threshold}
                    stickToMarkers={false}
                    onValueChange={(v: number) => update("threshold", Math.round(v * 100) / 100)}
                    onValueRender={(v: number) => v.toFixed(2)}
                    onMarkerRender={(v: number) => v === 0 ? "twitchy" : v === 1 ? "strict" : v === FINAL_ONLY_THRESHOLD ? "final-only" : ""}
                />
                <Span size="sm" className={cl("hint")}>
                    {isFinalOnly(word.threshold)
                        ? "Final-only: waits until you finish the phrase and fires only if the recognizer is confident. Fewer false alarms, but noticeably later."
                        : "Fires the instant the word shows up mid-sentence, then checks the confidence when you finish. If it scores under this line, the hit is logged as a suspected false alarm below."}
                </Span>
            </Field>

            <Field label={`Cooldown · ${(word.cooldownMs / 1000).toFixed(1)}s`}>
                <Slider
                    markers={[0, 1000, 3000, 5000, 10000, 30000]}
                    minValue={0}
                    maxValue={30000}
                    initialValue={word.cooldownMs}
                    stickToMarkers={false}
                    onValueChange={(v: number) => update("cooldownMs", Math.min(MAX_COOLDOWN_MS, Math.round(v / 100) * 100))}
                    onValueRender={(v: number) => `${(v / 1000).toFixed(1)}s`}
                    onMarkerRender={(v: number) => `${v / 1000}s`}
                />
            </Field>

            <FormSwitch
                title="Also catch plurals"
                description={pluralDescription(word.phrase)}
                value={word.matchPlurals}
                onChange={v => update("matchPlurals", v)}
            />

            <FormSwitch
                title="Use its own reaction"
                description="Otherwise this word uses the reaction below the list."
                value={word.reaction != null}
                onChange={on => update("reaction", on ? makeReaction({ ...settings.store.defaultReaction }) : null)}
            />

            {word.reaction
                ? <ReactionEditor reaction={word.reaction} phrase={word.phrase} onChanged={onChanged} />
                : (
                    <Button size="small" className={cl("preview")} onClick={() => void testReaction(reaction, word.phrase)}>
                        ▶ Test reaction
                    </Button>
                )}

            <Paragraph className={cl("hint")}>
                This session: {session?.hits ?? 0} caught, {session?.fired ?? 0} played, {session?.confirmed ?? 0} confirmed,{" "}
                {session?.suspected ?? 0} suspected false alarm{session?.suspected === 1 ? "" : "s"}
                {session?.lastSuspectedConfidence != null && ` (last scored ${session.lastSuspectedConfidence.toFixed(2)})`}.
                {" "}Lifetime: {word.hitCount}.
            </Paragraph>

            <Button className={cl("delete")} variant="dangerPrimary" size="small" onClick={onDelete}>
                Delete word
            </Button>
        </div>
    );
}

function AddWord({ words, onChanged }: { words: TargetWord[]; onChanged(): void; }) {
    const [draft, setDraft] = useState("");
    const phrase = normalizePhrase(draft);
    const duplicate = words.some(w => w.phrase === phrase);
    const error = draft.trim() ? (phraseError(phrase) ?? (duplicate ? "That word is already on the list." : null)) : null;

    const add = () => {
        if (!draft.trim() || error) return;
        words.push(makeWord(phrase, newId));
        setDraft("");
        onChanged();
    };

    return (
        <div className={cl("add")}>
            <Flex style={{ gap: "0.5em", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                    <TextInput
                        value={draft}
                        placeholder="Add a word or short phrase, e.g. like"
                        spellCheck={false}
                        onChange={(v: string) => setDraft(v)}
                        onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && add()}
                    />
                </div>
                <Button onClick={add} disabled={!draft.trim() || !!error}>Add</Button>
            </Flex>
            {error && <Paragraph className={cl("error")}>{error}</Paragraph>}
        </div>
    );
}

function ImportFromVariableFilter({ words, onChanged }: { words: TargetWord[]; onChanged(): void; }) {
    const [offer, setOffer] = useState<string[] | null>(null);
    const [picked, setPicked] = useState<Set<string>>(new Set());

    const look = () => {
        let rules: unknown;
        // VariableFilter may not be installed; this is a one-way, defensive read (§5.4)
        try {
            rules = (Settings.plugins as any).VariableFilter?.rules;
        } catch {
            rules = undefined;
        }
        const phrases = phrasesFromVariableFilter(rules, words.map(w => w.phrase));
        setOffer(phrases);
        setPicked(new Set(phrases));
    };

    if (!offer) {
        return <Button size="small" variant="secondary" onClick={look}>Import phrases from VariableFilter…</Button>;
    }

    return (
        <Card className={cl("import")}>
            {!offer.length
                ? <Paragraph className={cl("hint")}>No importable phrases found. Only plain (non-regex) phrase rules made of letters, digits and spaces can be spoken.</Paragraph>
                : (
                    <>
                        <Paragraph>These VariableFilter phrase rules can be listened for. They're copied, not linked — editing one later won't change the other.</Paragraph>
                        {offer.map(p => (
                            <label key={p} className={cl("inline-switch")}>
                                <Switch
                                    checked={picked.has(p)}
                                    onChange={on => {
                                        const next = new Set(picked);
                                        if (on) next.add(p);
                                        else next.delete(p);
                                        setPicked(next);
                                    }}
                                />
                                <Span size="sm">{p}</Span>
                            </label>
                        ))}
                    </>
                )}
            <Flex style={{ gap: "0.5em", marginTop: "0.5em" }}>
                {!!offer.length && (
                    <Button
                        size="small"
                        disabled={!picked.size}
                        onClick={() => {
                            for (const p of offer) if (picked.has(p)) words.push(makeWord(p, newId));
                            setOffer(null);
                            onChanged();
                        }}
                    >
                        Add {picked.size} word{picked.size === 1 ? "" : "s"}
                    </Button>
                )}
                <Button size="small" variant="secondary" onClick={() => setOffer(null)}>Close</Button>
            </Flex>
        </Card>
    );
}

function WordsSection({ words, onChanged }: { words: TargetWord[]; onChanged(): void; }) {
    useSubscription(subscribeStatus);
    const { rejected } = getStatus();

    return (
        <section>
            <HeadingSecondary>Words to catch</HeadingSecondary>
            <Paragraph>
                Lowercase words or short phrases, as you'd say them. Each word has a <b>sensitivity</b>: low catches more
                but misfires on sound-alikes (“duck”, “luck”), high misses more but rarely misfires. At{" "}
                {FINAL_ONLY_THRESHOLD.toFixed(2)} and above a word switches to <b>final-only</b>, trading speed for accuracy.
                This trade-off is the single most important thing to tune.
            </Paragraph>

            <Flex flexDirection="column" style={{ gap: "0.5em", paddingBottom: "1em" }}>
                {!words.length && (
                    <Card variant="info">
                        <Paragraph>
                            No words yet. Add the word you're trying to stop saying — MouthWash doesn't ship any, because
                            there's no universal one.
                        </Paragraph>
                    </Card>
                )}

                {words.map((word, index) => (
                    <ExpandableSection
                        key={word.id}
                        renderContent={() => (
                            <WordEditor
                                word={word}
                                onChanged={onChanged}
                                onDelete={() => {
                                    words.splice(index, 1);
                                    forgetWord(word.id);
                                    onChanged();
                                }}
                            />
                        )}
                    >
                        <div className={cl("row-header")}>
                            <Span weight="medium" size="md" className={cl("row-title")}>{word.phrase || "(empty)"}</Span>
                            <Span size="sm" className={cl("badge")} title="Sensitivity">
                                {word.threshold.toFixed(2)} · {thresholdLabel(word.threshold)}
                            </Span>
                            {rejected[word.id] && <Span size="sm" className={cl("badge", "badge-error")}>refused</Span>}
                            <Span size="sm" className={cl("row-meta")}>{word.hitCount} hit{word.hitCount === 1 ? "" : "s"}</Span>
                            <div onClick={e => e.stopPropagation()}>
                                <Switch
                                    checked={word.enabled}
                                    disabled={!!phraseError(word.phrase)}
                                    onChange={v => {
                                        word.enabled = v;
                                        onChanged();
                                    }}
                                />
                            </div>
                        </div>
                    </ExpandableSection>
                ))}

                <AddWord words={words} onChanged={onChanged} />
                <ImportFromVariableFilter words={words} onChanged={onChanged} />
            </Flex>
        </section>
    );
}

// #endregion

// #region stats

function StatsSection({ words, onChanged }: { words: TargetWord[]; onChanged(): void; }) {
    useSubscription(subscribeStats);
    const totals = getSessionTotals();

    return (
        <section>
            <HeadingSecondary>Stats</HeadingSecondary>
            <Paragraph className={cl("hint")}>
                Counts only — never what was said. Session figures live in memory and reset when Discord restarts; lifetime
                hit counts are kept in your local settings file. Nothing is ever sent anywhere.
            </Paragraph>

            <Card className={cl("stats")}>
                <div className={cl("stats-row", "stats-head")}>
                    <span>Word</span><span>Session</span><span>Played</span><span>Suspected</span><span>Lifetime</span>
                </div>
                {words.map(w => {
                    const s = getSessionStats(w.id);
                    return (
                        <div key={w.id} className={cl("stats-row")}>
                            <span>{w.phrase}</span>
                            <span>{s?.hits ?? 0}</span>
                            <span>{s?.fired ?? 0}</span>
                            <span className={s?.suspected ? cl("warn") : undefined}>{s?.suspected ?? 0}</span>
                            <span>{w.hitCount}</span>
                        </div>
                    );
                })}
                <div className={cl("stats-row", "stats-total")}>
                    <span>Total</span><span>{totals.hits}</span><span>{totals.fired}</span><span>{totals.suspected}</span>
                    <span>{words.reduce((n, w) => n + w.hitCount, 0)}</span>
                </div>
            </Card>

            <Flex style={{ gap: "0.5em" }}>
                <Button size="small" variant="secondary" onClick={resetSession}>Reset session</Button>
                <Button
                    size="small"
                    variant="dangerSecondary"
                    onClick={() => {
                        for (const w of words) w.hitCount = 0;
                        onChanged();
                    }}
                >
                    Reset lifetime counts
                </Button>
            </Flex>
        </section>
    );
}

// #endregion

// #region advanced

function CacheControls() {
    const [info, setInfo] = useState<{ path: string; files: { id: string; bytes: number; }[]; } | null>(null);
    const refresh = useCallback(() => void getCacheInfo().then(setInfo).catch(() => setInfo(null)), []);
    useEffect(refresh, [refresh]);

    const total = info?.files.reduce((n, f) => n + f.bytes, 0) ?? 0;

    return (
        <Field label="Model cache">
            <Span size="sm" className={cl("hint")}>
                {info?.files.length ? `${formatMB(total)} in ${info.path}` : "Empty — nothing downloaded."}
            </Span>
            <Button
                size="small"
                variant="dangerSecondary"
                disabled={!info?.files.length}
                onClick={async () => {
                    await clearCache();
                    refresh();
                    reloadEngine();
                }}
            >
                Clear model cache
            </Button>
        </Field>
    );
}

function OutputDevicePicker() {
    const { outputDeviceId } = settings.use(["outputDeviceId"]);
    const [devices, setDevices] = useState<{ id: string; label: string; }[]>([]);
    useEffect(() => void listOutputDevices().then(setDevices), []);
    useSubscription(subscribeOutput);

    // resolve now, so the line below names the real device even before the first reaction
    useEffect(() => void reactionPlayer.refreshSink(), [outputDeviceId]);

    const options = [
        { label: "Follow Discord's output device", value: "" },
        ...devices.map(d => ({ label: isVirtualDevice(d.label) ? `${d.label} (virtual)` : d.label, value: d.id }))
    ];

    return (
        <Field label="Reactions play on">
            <Select
                options={options}
                closeOnSelect
                isSelected={(v: string) => v === (outputDeviceId ?? "")}
                select={(v: string) => {
                    settings.store.outputDeviceId = v || null;
                }}
                serialize={(v: string) => v}
            />
            <Span size="sm" className={cl("hint")}>Currently: {reactionPlayer.output}</Span>
            {reactionPlayer.outputIsVirtual && (
                <Card variant="warning">
                    <Paragraph>
                        Reactions are going to a virtual audio device, so you probably won't hear them, and if that
                        device feeds your mic chain (a voice changer or soundboard) others might. Choose your
                        headphones above.
                    </Paragraph>
                </Card>
            )}
        </Field>
    );
}

function InputDevicePicker() {
    const { inputDeviceId } = settings.use(["inputDeviceId"]);
    const [devices, setDevices] = useState<{ id: string; label: string; }[]>([]);
    useEffect(() => void listInputDevices().then(setDevices), []);

    const options = [
        { label: "Follow Discord's input device", value: "" },
        ...devices.map(d => ({ label: d.label, value: d.id }))
    ];

    return (
        <Field label="Microphone">
            <Select
                options={options}
                closeOnSelect
                isSelected={(v: string) => v === (inputDeviceId ?? "")}
                select={(v: string) => {
                    settings.store.inputDeviceId = v || null;
                }}
                serialize={(v: string) => v}
            />
            <Span size="sm" className={cl("hint")}>Takes effect the next time the mic opens.</Span>
        </Field>
    );
}

function JsonEditor({ onChanged }: { onChanged(): void; }) {
    const serialize = useCallback(() => JSON.stringify(settings.store.words, null, 4), []);
    const [draft, setDraft] = useState(serialize);
    const [error, setError] = useState<string | null>(null);

    const apply = () => {
        try {
            const parsed = JSON.parse(draft);
            if (!Array.isArray(parsed)) throw new Error("Expected an array of words");
            settings.store.words = normalizeWordList(parsed, newId);
            setDraft(serialize());
            setError(null);
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    return (
        <Field label="Edit words as JSON">
            <textarea className={cl("json")} value={draft} spellCheck={false} onChange={e => setDraft(e.currentTarget.value)} />
            {error && <Paragraph className={cl("error")}>{error}</Paragraph>}
            <Flex style={{ gap: "0.5em" }}>
                <Button size="small" onClick={apply}>Apply</Button>
                <Button size="small" variant="secondary" onClick={() => { setDraft(serialize()); setError(null); }}>Reload from settings</Button>
            </Flex>
        </Field>
    );
}

function AdvancedSection({ onChanged }: { onChanged(): void; }) {
    const s = settings.use([
        "engine", "modelId", "useRestrictedGrammar", "requireVoiceConnection", "requireUnmuted", "requireTransmitting",
        "listenInDMCalls", "transmitSource", "rmsThreshold", "globalCooldownMs", "showStats"
    ]);

    const gateSwitch = (key: "requireVoiceConnection" | "requireUnmuted" | "requireTransmitting" | "listenInDMCalls", title: string, description: string) => (
        <FormSwitch
            title={title}
            description={description}
            value={s[key]}
            onChange={v => {
                settings.store[key] = v;
                reevaluateGate();
            }}
        />
    );

    return (
        <ExpandableSection
            renderContent={() => (
                <div className={cl("editor")}>
                    <Field label="Speech engine">
                        <Segmented<EngineChoice>
                            value={s.engine}
                            options={[["auto", "Automatic"], ["webspeech", "On-device Web Speech"], ["vosk", "Vosk"]]}
                            onChange={v => {
                                settings.store.engine = v;
                                reloadEngine();
                            }}
                        />
                        <Span size="sm" className={cl("hint")}>
                            Automatic prefers on-device Web Speech when this client provides it, otherwise Vosk. Cloud speech
                            recognition is never used.
                        </Span>
                    </Field>

                    <Field label="Vosk model">
                        <Segmented
                            value={s.modelId}
                            options={Object.values(MODELS).map(m => [m.id, `${m.label} (${formatMB(m.archive.bytes)})`])}
                            onChange={v => {
                                settings.store.modelId = v;
                                reloadEngine();
                            }}
                        />
                    </Field>

                    <CacheControls />

                    <FormSwitch
                        title="Restricted grammar (not recommended)"
                        description="Limit Vosk to your words plus a catch-all. Cheaper, but with only a few short words to choose from it hears them in ordinary speech constantly. Leave off unless debugging."
                        value={s.useRestrictedGrammar}
                        onChange={v => {
                            settings.store.useRestrictedGrammar = v;
                            onChanged();
                        }}
                    />

                    {gateSwitch("requireVoiceConnection", "Only in a voice call", "Off: also listen outside calls (needs transmit detection set to input level, since Discord only reports speaking in calls).")}
                    {gateSwitch("requireUnmuted", "Only while unmuted", "Off: keep listening while muted.")}
                    {gateSwitch("requireTransmitting", "Only while transmitting", "Off: listen whenever the mic is open, not just while Discord is sending your voice.")}
                    {gateSwitch("listenInDMCalls", "Also in DM and group calls", "Off: only listen in server voice channels.")}

                    <Field label="Transmit detection">
                        <Segmented<TransmitSource>
                            value={s.transmitSource}
                            options={[["discord", "Discord (push-to-talk / voice activity)"], ["level", "Input level (fallback)"]]}
                            onChange={v => {
                                settings.store.transmitSource = v;
                                reevaluateGate();
                            }}
                        />
                        <Span size="sm" className={cl("hint")}>
                            Input level duplicates Discord's voice detection and will disagree with it — use it only if
                            Discord's speaking signal stops working.
                        </Span>
                    </Field>

                    {s.transmitSource === "level" && (
                        <Field label={`Input level threshold · ${s.rmsThreshold.toFixed(3)}`}>
                            <Slider
                                markers={[0.005, 0.02, 0.05, 0.1]}
                                minValue={0.005}
                                maxValue={0.1}
                                initialValue={s.rmsThreshold}
                                stickToMarkers={false}
                                onValueChange={(v: number) => { settings.store.rmsThreshold = v; }}
                                onValueRender={(v: number) => v.toFixed(3)}
                            />
                        </Field>
                    )}

                    <Field label={`Minimum gap between any two reactions · ${(s.globalCooldownMs / 1000).toFixed(1)}s`}>
                        <Slider
                            markers={[0, 1000, 1500, 3000, 5000, 10000]}
                            minValue={0}
                            maxValue={10000}
                            initialValue={s.globalCooldownMs}
                            stickToMarkers={false}
                            onValueChange={(v: number) => { settings.store.globalCooldownMs = Math.round(v / 100) * 100; }}
                            onValueRender={(v: number) => `${(v / 1000).toFixed(1)}s`}
                            onMarkerRender={(v: number) => `${v / 1000}s`}
                        />
                    </Field>

                    <InputDevicePicker />

                    <FormSwitch title="Show stats" description="Show the per-word stats table." value={s.showStats} onChange={v => { settings.store.showStats = v; }} />

                    <JsonEditor onChanged={onChanged} />
                </div>
            )}
        >
            <Span weight="medium" size="md">Advanced</Span>
        </ExpandableSection>
    );
}

// #endregion

export const MouthWashSettingsPanel = ErrorBoundary.wrap(() => {
    const forceUpdate = useForceUpdate();
    const store = settings.use(["words", "defaultReaction", "showStats"]);
    const words = store.words ?? [];

    const onChanged = () => {
        forceUpdate();
        onWordsChanged();
    };

    return (
        <div className={cl("settings")}>
            <StatusPanel />
            <WordsSection words={words} onChanged={onChanged} />
            <DefaultReactionSection onChanged={onChanged} />
            {store.showStats && !!words.length && <StatsSection words={words} onChanged={onChanged} />}
            <AdvancedSection onChanged={onChanged} />
        </div>
    );
}, { message: "Failed to render MouthWash settings" });
