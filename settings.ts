/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { DEFAULT_MODEL_ID } from "./engine/modelCache";
import { MouthWashSettingsPanel } from "./settingsComponents";
import type { EngineChoice, ReactionConfig, TargetWord, TransmitSource } from "./types";
import { DEFAULT_GLOBAL_COOLDOWN_MS, DEFAULT_REACTION } from "./words";

/*
 * Every option is hidden from Vencord's generic renderer and drawn by the panel component
 * instead, so status, word list, reactions and advanced settings read as one page (§9).
 * No default words ship (§17): an empty list with a clear call to action is the first-run state.
 */
export const settings = definePluginSettings({
    words: {
        type: OptionType.CUSTOM,
        default: [] as TargetWord[],
        description: "Words to listen for"
    },
    defaultReaction: {
        type: OptionType.CUSTOM,
        default: { ...DEFAULT_REACTION } as ReactionConfig,
        description: "Reaction used by words without their own"
    },

    /** master switch, separate from the plugin being enabled (§7.4) */
    listening: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Listen while the conditions below hold",
        hidden: true
    },

    requireVoiceConnection: { type: OptionType.BOOLEAN, default: true, description: "Only in a voice call", hidden: true },
    requireUnmuted: { type: OptionType.BOOLEAN, default: true, description: "Only while unmuted", hidden: true },
    requireTransmitting: { type: OptionType.BOOLEAN, default: true, description: "Only while transmitting", hidden: true },
    listenInDMCalls: { type: OptionType.BOOLEAN, default: true, description: "Also in DM and group calls", hidden: true },

    engine: {
        type: OptionType.CUSTOM,
        default: "auto" as EngineChoice,
        description: "Speech engine"
    },
    modelId: {
        type: OptionType.CUSTOM,
        default: DEFAULT_MODEL_ID,
        description: "Vosk model"
    },
    /**
     * Off by default, against spec §6.3: measured on the small English model, a grammar of a few
     * short words plus [unk] maps ordinary speech onto those words constantly (12–14 false hits
     * per 45 s of neutral talk vs 0–1 with the open vocabulary). See README "Vocabulary".
     */
    useRestrictedGrammar: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Restrict Vosk to the word list (misfires heavily; for debugging only)",
        hidden: true
    },
    /** one-time migrations of stored values; see controller.normalizeSettings */
    settingsVersion: {
        type: OptionType.NUMBER,
        default: 0,
        description: "Settings migration version",
        hidden: true
    },

    globalCooldownMs: {
        type: OptionType.NUMBER,
        default: DEFAULT_GLOBAL_COOLDOWN_MS,
        description: "Minimum time between any two reactions",
        hidden: true
    },
    inputDeviceId: {
        type: OptionType.CUSTOM,
        default: null as string | null,
        description: "Microphone override (null follows Discord's input)"
    },

    outputDeviceId: {
        type: OptionType.CUSTOM,
        default: null as string | null,
        description: "Where reactions play (null follows Discord's output)"
    },

    transmitSource: {
        type: OptionType.CUSTOM,
        default: "discord" as TransmitSource,
        description: "Where 'transmitting' comes from"
    },
    rmsThreshold: {
        type: OptionType.NUMBER,
        default: 0.02,
        description: "Level threshold for the level-based transmit fallback",
        hidden: true
    },

    showStats: { type: OptionType.BOOLEAN, default: true, description: "Show session stats", hidden: true },

    manager: {
        type: OptionType.COMPONENT,
        component: MouthWashSettingsPanel
    }
});

export const getWords = (): TargetWord[] => settings.store.words ?? [];
