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
        description: "Send your own sounds and music to the voice channel. When off, only you hear them",
        default: true,
        onChange: () => applyVolumes()
    },
    voiceVolume: {
        type: OptionType.SLIDER,
        description: "Volume other people hear your own sounds and music at",
        markers: [0, 25, 50, 75, 100, 125, 150],
        default: 100,
        stickToMarkers: false,
        onChange: () => applyVolumes()
    },
    localVolume: {
        type: OptionType.SLIDER,
        description: "Volume you hear your own sounds, music and previews at",
        markers: [0, 25, 50, 75, 100],
        default: 50,
        stickToMarkers: false,
        onChange: () => applyVolumes()
    },
    musicVolume: {
        type: OptionType.SLIDER,
        description: "Music volume (applies to both you and the voice channel)",
        markers: [0, 25, 50, 75, 100],
        default: 60,
        stickToMarkers: false,
        onChange: () => applyMusicVolume()
    },
    serverSoundsThroughMic: {
        type: OptionType.BOOLEAN,
        description: "Always play server soundboard sounds through your microphone instead of Discord's soundboard. Sounds you aren't allowed to use on the soundboard always go through your microphone",
        default: false
    },
    allowOverlap: {
        type: OptionType.BOOLEAN,
        description: "Let your own sounds overlap. When off, playing a sound stops the previous one",
        default: true
    },
    holdPushToTalk: {
        type: OptionType.BOOLEAN,
        description: "Keep transmitting while your own audio plays, even when using Push to Talk",
        default: true
    },
    webrtcEngine: {
        type: OptionType.BOOLEAN,
        description: "Use Discord's WebRTC voice engine on the desktop app. The native engine can't mix your own audio into the microphone, so this is required for others to hear it. Screen sharing then uses SoundPanel's own screen picker",
        default: false,
        restartNeeded: true,
        hidden: !IS_DISCORD_DESKTOP
    },
    maxVideoQuality: {
        type: OptionType.BOOLEAN,
        description: "With the WebRTC voice engine, send your camera at its best resolution and frame rate and your stream at exactly the quality you pick, at the highest bitrate Discord allows. Discord otherwise shrinks video to viewers' window sizes and lowers your camera's frame rate when you're quiet. Uses more upload bandwidth and CPU",
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
