/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "../settings";

let webrtc = !IS_DISCORD_DESKTOP;

export function detectVoiceEngine() {
    webrtc = !IS_DISCORD_DESKTOP || settings.store.webrtcEngine;
}

export const usesWebRTCEngine = () => webrtc;

export const usesDesktopWebRTC = () => IS_DISCORD_DESKTOP && webrtc;

const AUTO_SENSITIVITY_THRESHOLD = -40;

export function getVoiceActivityThreshold({ vadThreshold, vadAutoThreshold }: { vadThreshold: number; vadAutoThreshold?: boolean; }) {
    return vadAutoThreshold ? AUTO_SENSITIVITY_THRESHOLD : vadThreshold;
}
