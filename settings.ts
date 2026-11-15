/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { applyVolumes } from "./audio/mixer";
import { applyMusicVolume } from "./audio/player";

export type PanelTab = "server" | "sounds" | "music";
export type RepeatMode = "off" | "all" | "one";

export const settings = definePluginSettings({
    transmit: {
        type: OptionType.BOOLEAN,
        description: "Send your sounds and music to the voice channel. When off, only you hear them",
        default: true,
        onChange: applyVolumes
    },
    voiceVolume: {
        type: OptionType.SLIDER,
        description: "Volume others hear your sounds and music at",
        markers: [0, 25, 50, 75, 100, 125, 150],
        default: 100,
        stickToMarkers: false,
        onChange: applyVolumes
    },
    localVolume: {
        type: OptionType.SLIDER,
        description: "Volume you hear your sounds, music and previews at",
        markers: [0, 25, 50, 75, 100],
        default: 50,
        stickToMarkers: false,
        onChange: applyVolumes
    },
    musicVolume: {
        type: OptionType.SLIDER,
        description: "Music volume, for you and the voice channel",
        markers: [0, 25, 50, 75, 100],
        default: 60,
        stickToMarkers: false,
        onChange: applyMusicVolume
    },
    serverSoundsThroughMic: {
        type: OptionType.BOOLEAN,
        description: "Play server sounds through your microphone even where Discord's soundboard is allowed",
        default: false
    },
    allowOverlap: {
        type: OptionType.BOOLEAN,
        description: "Let your sounds overlap instead of stopping the previous one",
        default: true
    },
    holdPushToTalk: {
        type: OptionType.BOOLEAN,
        description: "Keep transmitting while your audio plays when using Push to Talk",
        default: true
    },
    webrtcEngine: {
        type: OptionType.BOOLEAN,
        description: "Use Discord's WebRTC voice engine. The desktop app's native engine can't carry your own audio, so others only hear it with this on",
        default: false,
        restartNeeded: true,
        hidden: !IS_DISCORD_DESKTOP
    },
    maxVideoQuality: {
        type: OptionType.BOOLEAN,
        description: "With the WebRTC engine, send your camera and streams at full quality instead of shrinking them to viewers' window sizes. Uses more bandwidth and CPU",
        default: true,
        hidden: !IS_DISCORD_DESKTOP
    },
    activeTab: {
        type: OptionType.STRING,
        description: "Last opened tab",
        default: "server" as PanelTab,
        hidden: true
    },
    repeatMode: {
        type: OptionType.STRING,
        description: "Music repeat mode",
        default: "all" as RepeatMode,
        hidden: true
    },
    shuffle: {
        type: OptionType.BOOLEAN,
        description: "Shuffle music",
        default: false,
        hidden: true
    }
});
