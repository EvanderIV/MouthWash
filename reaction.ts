/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * ReactionPlayer (§10.1).
 *
 * The reaction must never enter the outgoing audio stream. It plays through its own AudioContext
 * whose sink is Discord's *output* device, completely separate from the capture graph — no node
 * here is ever connected to anything that feeds a microphone path. Discord transmits from its
 * own native capture, which this context cannot reach.
 *
 * (Acoustic leakage is the one thing code cannot prevent: on open speakers, a loud buzzer can be
 * picked up by the mic like any other sound. The settings panel says to use headphones.)
 */

import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { showToast } from "@webpack/common";

import { defaultOutputLabel, isVirtualDevice, resolveWebDevice } from "./audio/devices";
import { getDiscordOutputDevice, logOnce } from "./fluxEvents";
import { PRESET_SOUND_IDS, presetSoundBytes } from "./presetSounds";
import { settings } from "./settings";
import type { PresetSoundId, ReactionConfig } from "./types";

const Native = VencordNative.pluginHelpers.MouthWash as PluginNative<typeof import("./native")>;
const logger = new Logger("MouthWash");

/** Custom sounds are cut off after this, so a long file cannot drone on. */
const MAX_SOUND_SECONDS = 5;
/** How long an unused output context lingers before it is closed. */
const IDLE_CLOSE_MS = 8000;

type SinkContext = AudioContext & { setSinkId?(id: string): Promise<void>; sinkId?: string; };

export class ReactionPlayer {
    private ctx: SinkContext | null = null;
    private warmers = 0;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private sounds = new Map<string, AudioBuffer>();
    private outputLabel = "System default";
    /** what the current sink was resolved from; re-resolved whenever this changes */
    private sinkKey: string | null = null;
    private sinkRefresh: Promise<void> | null = null;
    private outputListeners = new Set<() => void>();

    get output(): string {
        return this.outputLabel;
    }

    get outputIsVirtual(): boolean {
        return isVirtualDevice(this.outputLabel);
    }

    subscribeOutput(listener: () => void): () => void {
        this.outputListeners.add(listener);
        return () => void this.outputListeners.delete(listener);
    }

    /** The user's explicit choice, else Discord's output, read fresh every time. */
    private currentSinkKey(): string {
        return settings.store.outputDeviceId ?? `discord:${getDiscordOutputDevice()?.id ?? "default"}`;
    }

    /** Keep an output context ready while listening, so the first buzz is not delayed by setup. */
    warm(): void {
        this.warmers++;
        this.cancelIdleClose();
        this.ensureContext();
        void this.refreshSink();
        this.predecodePresets();
    }

    release(): void {
        this.warmers = Math.max(0, this.warmers - 1);
        if (!this.warmers) this.scheduleIdleClose();
    }

    /**
     * Route the context to the chosen output, or Discord's. Called when the context is created
     * and again before any reaction whose target has changed since — so switching outputs, in
     * Discord or here, takes effect on the very next reaction rather than the next call.
     */
    refreshSink(): Promise<void> {
        this.sinkRefresh ??= this.doRefreshSink().finally(() => { this.sinkRefresh = null; });
        return this.sinkRefresh;
    }

    private async doRefreshSink(): Promise<void> {
        const { ctx } = this;
        const key = this.currentSinkKey();

        try {
            const device = await resolveWebDevice("audiooutput", getDiscordOutputDevice(), settings.store.outputDeviceId);
            const target = device.deviceId ?? "";
            if (ctx?.setSinkId && (ctx.sinkId ?? "") !== target) await ctx.setSinkId(target);
            this.outputLabel = device.label;
        } catch (e) {
            logOnce("sink", "Could not route the reaction to the chosen output; using the system default", e);
            this.outputLabel = `${await defaultOutputLabel()} (routing failed)`;
        }

        this.sinkKey = key;
        this.outputListeners.forEach(l => l());
    }

    private async ensureSink(): Promise<void> {
        if (this.sinkKey !== this.currentSinkKey()) await this.refreshSink();
        else if (this.sinkRefresh) await this.sinkRefresh;
    }

    /**
     * Play a reaction. `audible: false` (deafened) skips every sound but still shows toasts —
     * the hit is counted by the caller either way.
     */
    async play(reaction: ReactionConfig, phrase: string, { audible }: { audible: boolean; }): Promise<void> {
        const toastText = `MouthWash: "${phrase}"`;
        const volume = Math.min(1, Math.max(0, reaction.volume));

        if (reaction.kind === "toast" || reaction.alsoToast) {
            showToast(toastText, "message");
        }

        if (!audible || reaction.kind === "silent" || reaction.kind === "toast") return;

        try {
            // a no-op unless the output changed; then a few ms, which beats playing to the wrong device
            this.ensureContext();
            await this.ensureSink();

            switch (reaction.kind) {
                case "buzzer":
                    this.buzzer(volume);
                    break;
                case "preset":
                    await this.preset(reaction.preset ?? PRESET_SOUND_IDS[0], volume);
                    break;
                case "beep":
                    this.beep(volume);
                    break;
                case "customSound":
                    await this.customSound(reaction.soundPath, volume);
                    break;
                case "tts":
                    this.speak(reaction.ttsText?.trim() || `you said ${phrase}`, volume);
                    break;
            }
        } catch (e) {
            logger.error("Reaction failed to play", e);
        } finally {
            if (!this.warmers) this.scheduleIdleClose();
        }
    }

    dispose(): void {
        this.cancelIdleClose();
        this.warmers = 0;
        this.ctx?.close().catch(() => { });
        this.ctx = null;
        this.sounds.clear();
        try {
            speechSynthesis.cancel();
        } catch { }
    }

    private ensureContext(): SinkContext {
        if (!this.ctx || this.ctx.state === "closed") {
            this.ctx = new AudioContext({ latencyHint: "interactive" }) as SinkContext;
            // a new context starts on the system default; force a re-route
            this.sinkKey = null;
            void this.refreshSink();
        }
        if (this.ctx.state === "suspended") this.ctx.resume().catch(() => { });
        return this.ctx;
    }

    private cancelIdleClose() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    private scheduleIdleClose() {
        this.cancelIdleClose();
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (this.warmers) return;
            this.ctx?.close().catch(() => { });
            this.ctx = null;
        }, IDLE_CLOSE_MS);
    }

    /**
     * The default: a short, unpleasant, detuned square/saw burst with a fast envelope, ~250 ms.
     * Procedural, so there is no asset to ship and volume is trivially controllable.
     */
    private buzzer(volume: number) {
        const ctx = this.ensureContext();
        const t = ctx.currentTime + 0.003;
        const peak = 0.35 * volume;

        const out = ctx.createGain();
        out.gain.setValueAtTime(0, t);
        out.gain.linearRampToValueAtTime(peak, t + 0.008);
        out.gain.setValueAtTime(peak, t + 0.17);
        out.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);

        const lowpass = ctx.createBiquadFilter();
        lowpass.type = "lowpass";
        lowpass.frequency.value = 2600;
        lowpass.connect(out);
        out.connect(ctx.destination);

        const voices: [OscillatorType, number, number][] = [
            ["square", 140, 1],
            ["sawtooth", 147, 0.9],
            ["square", 70, 0.6]
        ];

        for (const [type, frequency, level] of voices) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.value = frequency;
            gain.gain.value = level;
            osc.connect(gain).connect(lowpass);
            osc.start(t);
            osc.stop(t + 0.27);
        }
    }

    private beep(volume: number) {
        const ctx = this.ensureContext();
        const t = ctx.currentTime + 0.003;
        const peak = 0.5 * volume;

        const out = ctx.createGain();
        out.gain.setValueAtTime(0, t);
        out.gain.linearRampToValueAtTime(peak, t + 0.005);
        out.gain.setValueAtTime(peak, t + 0.1);
        out.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
        out.connect(ctx.destination);

        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = 880;
        osc.connect(out);
        osc.start(t);
        osc.stop(t + 0.14);
    }

    /** Decode the bundled clips ahead of time so the first buzz has no decode delay. */
    private predecodePresets() {
        for (const id of PRESET_SOUND_IDS) void this.loadPreset(id).catch(() => { });
    }

    private async loadPreset(id: PresetSoundId): Promise<AudioBuffer> {
        const key = `preset:${id}`;
        const cached = this.sounds.get(key);
        if (cached) return cached;

        const buffer = await this.ensureContext().decodeAudioData(presetSoundBytes(id));
        this.sounds.set(key, buffer);
        return buffer;
    }

    private async preset(id: PresetSoundId, volume: number) {
        const buffer = await this.loadPreset(id).catch(e => {
            logOnce(`preset:${id}`, `Bundled sound "${id}" could not be decoded; using the buzzer`, e);
            return null;
        });

        if (buffer) this.playBuffer(buffer, volume);
        else this.buzzer(volume);
    }

    private playBuffer(buffer: AudioBuffer, volume: number) {
        const ctx = this.ensureContext();
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = buffer;
        gain.gain.value = volume;
        source.connect(gain).connect(ctx.destination);
        source.start();
        source.stop(ctx.currentTime + MAX_SOUND_SECONDS);
    }

    private async loadSound(path: string): Promise<AudioBuffer | null> {
        const cached = this.sounds.get(path);
        if (cached) return cached;

        const data = await Native.readCustomSound(path);
        if (!data) return null;

        const buffer = await this.ensureContext().decodeAudioData(data);
        this.sounds.set(path, buffer);
        return buffer;
    }

    private async customSound(path: string | undefined, volume: number) {
        const buffer = path ? await this.loadSound(path).catch(() => null) : null;

        if (!buffer) {
            logOnce(`sound:${path}`, `Custom sound "${path}" could not be read; playing a beep instead`);
            showToast("MouthWash: custom sound couldn't be played — using a beep", "failure");
            this.beep(volume);
            return;
        }

        this.playBuffer(buffer, volume);
    }

    /**
     * Speech synthesis, with on-device voices only. Some Chromium voices are network services;
     * using one would tell a third party each time the user slipped, which §12 forbids. With no
     * local voice available, this falls back to a beep.
     *
     * Note: speechSynthesis always plays on the system default output — it cannot be routed to
     * Discord's chosen device the way the AudioContext reactions are.
     */
    private speak(text: string, volume: number) {
        const voice = speechSynthesis.getVoices().find(v => v.localService && v.lang.toLowerCase().startsWith("en"))
            ?? speechSynthesis.getVoices().find(v => v.localService);

        if (!voice) {
            logOnce("tts-voice", "No on-device speech voice is installed; using a beep instead of TTS");
            this.beep(volume);
            return;
        }

        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = voice;
        utterance.volume = volume;
        utterance.rate = 1.15;
        speechSynthesis.speak(utterance);
    }
}

export const reactionPlayer = new ReactionPlayer();
