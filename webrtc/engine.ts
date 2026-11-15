/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "../settings";

let webrtc = !IS_DISCORD_DESKTOP;

// Discord picks its voice engine once at startup, so a changed setting only counts after a restart
export function detectVoiceEngine() {
    webrtc = !IS_DISCORD_DESKTOP || settings.store.webrtcEngine;
}

// The browser and Vesktop always use the WebRTC engine
export const usesWebRTCEngine = () => webrtc;

// The desktop app needs extra help in WebRTC mode: screen sharing, codecs and video quality
export const usesDesktopWebRTC = () => IS_DISCORD_DESKTOP && webrtc;

// The WebRTC engine ignores "Automatically determine input sensitivity" and uses the hidden slider value instead.
// That's -60 dB unless you moved it, low enough for background noise to count as speech, so you show as speaking
// all the time. The engine's own default works much better.
const AUTO_SENSITIVITY_THRESHOLD = -40;

export function getVoiceActivityThreshold({ vadThreshold, vadAutoThreshold }: { vadThreshold: number; vadAutoThreshold?: boolean; }) {
    return vadAutoThreshold ? AUTO_SENSITIVITY_THRESHOLD : vadThreshold;
}
