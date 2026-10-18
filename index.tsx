/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";

import { start, stop, toggleListening } from "./controller";
import { fluxHandlers } from "./fluxEvents";
import { settings } from "./settings";

const logger = new Logger("MouthWash");

export default definePlugin({
    name: "MouthWash",
    description:
        "Listens to your own microphone while you're talking in a voice call and plays a sound you " +
        "choose when you say a word you're trying to stop saying. Everything runs on your device — " +
        "no audio, text, or detection ever leaves the client, and nothing is recorded. Only your own " +
        "mic is ever opened, never anyone else's. Short words are hard to detect reliably; expect to " +
        "tune it.",
    authors: [{ name: "evanm", id: 628373174001860628n }],
    tags: ["Voice", "Utility", "Privacy"],

    settings,

    // every event name lives in fluxEvents.ts, so a Discord rename is a one-file fix (§7)
    flux: fluxHandlers,

    // a quick mute for the feature that doesn't tear down the model (§7.4)
    toolboxActions: {
        "Toggle MouthWash listening": toggleListening
    },

    start() {
        start().catch(e => logger.error("Failed to start", e));
    },

    stop() {
        try {
            stop();
        } catch (e) {
            logger.error("Failed to stop cleanly", e);
        }
    }
});
