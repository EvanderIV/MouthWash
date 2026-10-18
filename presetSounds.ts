/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Bundled reaction sounds from ./assets, inlined as base64 at build time. They ship inside the
 * plugin bundle, so playing one needs no disk read, no network and no CSP entry.
 */

import incorrectBuzzer from "file://assets/incorrect_buzzer.mp3?base64";
import legoHey from "file://assets/lego_hey.mp3?base64";

import type { PresetSoundId } from "./types";

export const PRESET_SOUNDS: Record<PresetSoundId, { label: string; base64: string; }> = {
    incorrectBuzzer: { label: "Incorrect buzzer", base64: incorrectBuzzer },
    legoHey: { label: "LEGO “hey!”", base64: legoHey }
};

export const PRESET_SOUND_IDS = Object.keys(PRESET_SOUNDS) as PresetSoundId[];

/** Fresh bytes each call — decodeAudioData detaches the buffer it is given. */
export function presetSoundBytes(id: PresetSoundId): ArrayBuffer {
    const binary = atob(PRESET_SOUNDS[id].base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}
