/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The isolated Discord-internals surface (§7, §11).
 *
 * Every Flux event name and every MediaEngineStore / RTCConnectionStore / VoiceStateStore method
 * MouthWash depends on is named in this one file, so a Discord update that renames one is a
 * one-file fix. Every read is wrapped: if the shape changes, the gate fails closed (not
 * listening) and the problem is logged once — it never throws into Discord.
 */

import { Logger } from "@utils/Logger";
import { findStoreLazy } from "@webpack";
import { ChannelStore, MediaEngineStore, RTCConnectionStore, UserStore, VoiceStateStore } from "@webpack/common";

import { type GateInputs, speakingFromEvent } from "./gate";

const logger = new Logger("MouthWash");
const loggedOnce = new Set<string>();

export function logOnce(key: string, message: string, error?: unknown): void {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    if (error !== undefined) logger.warn(message, error);
    else logger.warn(message);
}

/** Not exported from @webpack/common; optional secondary source for "am I speaking". */
const SpeakingStore = findStoreLazy("SpeakingStore");

export interface DiscordHooks {
    /** something that can affect the gate changed — re-read the stores */
    onStateChanged(): void;
    /** the current user's speaking state, from whichever source reported it */
    onSpeaking(speaking: boolean): void;
}

let hooks: DiscordHooks | null = null;

const notifyChanged = () => {
    try {
        hooks?.onStateChanged();
    } catch (e) {
        logger.error("Gate re-evaluation failed", e);
    }
};

/**
 * Flux handlers for definePlugin. Event names are internal API and may drift; the store change
 * listeners below are a second path to the same re-evaluation, so a renamed event degrades to
 * slightly slower updates rather than a stuck gate.
 */
export const fluxHandlers = {
    RTC_CONNECTION_STATE: notifyChanged,
    VOICE_CHANNEL_SELECT: notifyChanged,
    AUDIO_TOGGLE_SELF_MUTE: notifyChanged,
    AUDIO_TOGGLE_SELF_DEAF: notifyChanged,
    AUDIO_SET_MODE: notifyChanged,
    VOICE_STATE_UPDATES: notifyChanged,
    SPEAKING(event: any) {
        try {
            const speaking = speakingFromEvent(event, getCurrentUserId());
            if (speaking != null) hooks?.onSpeaking(speaking);
        } catch (e) {
            logOnce("speaking-event", "Could not read a SPEAKING event", e);
        }
    }
};

function onSpeakingStoreChange() {
    try {
        const me = getCurrentUserId();
        if (me && typeof SpeakingStore.isSpeaking === "function") {
            hooks?.onSpeaking(!!SpeakingStore.isSpeaking(me));
        }
    } catch (e) {
        logOnce("speaking-store", "SpeakingStore is unavailable; relying on the SPEAKING event only", e);
    }
}

const changeSources = () => [MediaEngineStore, RTCConnectionStore, VoiceStateStore];

export function subscribeDiscord(next: DiscordHooks): void {
    hooks = next;

    for (const store of changeSources()) {
        try {
            store.addChangeListener(notifyChanged);
        } catch (e) {
            logOnce("subscribe", "Could not subscribe to a Discord store", e);
        }
    }

    try {
        SpeakingStore.addChangeListener(onSpeakingStoreChange);
    } catch (e) {
        logOnce("speaking-store", "SpeakingStore is unavailable; relying on the SPEAKING event only", e);
    }
}

export function unsubscribeDiscord(): void {
    for (const store of changeSources()) {
        try {
            store.removeChangeListener(notifyChanged);
        } catch { }
    }

    try {
        SpeakingStore.removeChangeListener(onSpeakingStoreChange);
    } catch { }

    hooks = null;
}

export function getCurrentUserId(): string | undefined {
    try {
        return UserStore.getCurrentUser()?.id;
    } catch {
        return undefined;
    }
}

/** Everything the gate needs except "transmitting", which arrives as events. Fails closed. */
export function readGateInputs(): Omit<GateInputs, "transmitting"> {
    try {
        const channelId = RTCConnectionStore.getChannelId() ?? null;
        const inVoice = !!channelId && RTCConnectionStore.isConnected();

        let isDMCall: boolean | null = null;
        if (channelId) {
            const channel = ChannelStore.getChannel(channelId);
            isDMCall = channel ? !channel.guild_id : null;
        }

        const me = getCurrentUserId();
        const voiceState: any = me ? VoiceStateStore.getVoiceStateForUser(me) : undefined;

        const muted = MediaEngineStore.isSelfMute()
            || MediaEngineStore.isMute()
            || !!MediaEngineStore.isSelfMutedTemporarily?.()
            || !!voiceState?.mute
            || !!voiceState?.suppress;

        return { inVoice, isDMCall, muted };
    } catch (e) {
        logOnce("gate-read", "Could not read voice state from Discord — not listening until it can be read", e);
        return { inVoice: false, isDMCall: null, muted: true, readFailed: true };
    }
}

export function isDeafened(): boolean {
    try {
        return MediaEngineStore.isSelfDeaf() || MediaEngineStore.isDeaf();
    } catch {
        return false;
    }
}

/** Push-to-talk users get no pre-roll: audio from before the key went down was never sent. */
export function isPushToTalk(): boolean {
    try {
        return MediaEngineStore.getMode() === "PUSH_TO_TALK";
    } catch {
        // unknown → the stricter assumption
        return true;
    }
}

export interface DiscordDevice {
    id: string;
    name: string;
}

function selectedDevice(kind: "input" | "output"): DiscordDevice | null {
    try {
        const id = kind === "input" ? MediaEngineStore.getInputDeviceId() : MediaEngineStore.getOutputDeviceId();
        if (!id) return null;
        const devices = kind === "input" ? MediaEngineStore.getInputDevices() : MediaEngineStore.getOutputDevices();
        return { id, name: devices?.[id]?.name ?? "" };
    } catch {
        return null;
    }
}

/** The input Discord is using, so MouthWash follows it rather than the OS default (§8.1). */
export const getDiscordInputDevice = () => selectedDevice("input");
/** The output Discord is using, where the reaction should play (§10.1). */
export const getDiscordOutputDevice = () => selectedDevice("output");
