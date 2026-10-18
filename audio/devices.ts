/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Map Discord's audio devices onto web media device ids.
 *
 * Discord desktop runs its own native voice engine, whose device ids are OS identifiers, while
 * getUserMedia and AudioContext.setSinkId want the browser's per-origin device ids. The two only
 * sometimes coincide, so this matches by id first and by device name second, and otherwise
 * falls back to the system default rather than failing.
 */

import type { DiscordDevice } from "../fluxEvents";

export interface ResolvedDevice {
    /** undefined = system default */
    deviceId: string | undefined;
    label: string;
}

/** "Default - Headset (Foo) (1234:abcd)" → "headset (foo)" */
export function normalizeDeviceLabel(label: string): string {
    return label
        .toLowerCase()
        .replace(/^(default|communications)\s*-\s*/, "")
        .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/, "")
        .trim();
}

async function listDevices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    try {
        return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === kind);
    } catch {
        return [];
    }
}

async function listReal(kind: MediaDeviceKind, unnamed: string): Promise<{ id: string; label: string; }[]> {
    return (await listDevices(kind))
        .filter(d => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
        .map(d => ({ id: d.deviceId, label: d.label || unnamed }));
}

export const listInputDevices = () => listReal("audioinput", "Unnamed microphone");
export const listOutputDevices = () => listReal("audiooutput", "Unnamed output");

/**
 * Virtual audio cables and voice changers. A reaction sent to one is usually inaudible, and if
 * the cable is routed into a microphone chain it can end up in the call — exactly what §10.1
 * forbids. Matched by label, since that is all the web API exposes.
 */
const VIRTUAL_DEVICE = /\b(vb-audio|virtual|cable (input|output)|voicemeeter|voicemod|blackhole|soundflower|loopback)\b/i;

export const isVirtualDevice = (label: string) => VIRTUAL_DEVICE.test(label);

/** The label of the device the system default currently points at, e.g. "CABLE Input (…)". */
export async function defaultOutputLabel(): Promise<string> {
    const def = (await listDevices("audiooutput")).find(d => d.deviceId === "default");
    return def?.label.replace(/^default\s*-\s*/i, "") || "System default";
}

export async function resolveWebDevice(
    kind: "audioinput" | "audiooutput",
    discord: DiscordDevice | null,
    overrideId: string | null = null
): Promise<ResolvedDevice> {
    const devices = await listDevices(kind);
    // name what "default" actually is, so a default that points at a virtual cable is visible
    const defaultLabel = kind === "audiooutput" ? await defaultOutputLabel() : "System default";
    const fallback: ResolvedDevice = { deviceId: undefined, label: defaultLabel };

    if (overrideId) {
        const chosen = devices.find(d => d.deviceId === overrideId);
        if (chosen) return { deviceId: chosen.deviceId, label: chosen.label || "Chosen device" };
        // a chosen mic that has gone away falls through to following Discord
    }

    if (!discord || discord.id === "default") return fallback;

    const exact = devices.find(d => d.deviceId === discord.id);
    if (exact) return { deviceId: exact.deviceId, label: exact.label || discord.name };

    const want = normalizeDeviceLabel(discord.name);
    if (!want) return fallback;

    const named = devices.find(d => d.deviceId !== "default" && normalizeDeviceLabel(d.label) === want)
        ?? devices.find(d => {
            const have = normalizeDeviceLabel(d.label);
            return d.deviceId !== "default" && !!have && (have.includes(want) || want.includes(have));
        });

    return named ? { deviceId: named.deviceId, label: named.label } : { ...fallback, label: `${defaultLabel} (couldn't match "${discord.name}")` };
}
