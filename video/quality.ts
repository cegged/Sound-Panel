/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { settings } from "../settings";

// Video quality tweaks for Discord's WebRTC voice engine on the desktop app. Discord tunes that engine for
// browsers: a fixed 2.5 Mbps video cap, a 720p 30 FPS camera, and video scaled down to each viewer's tile size

const logger = new Logger("SoundPanel");

interface VideoQuality {
    width: number;
    height: number;
    framerate?: number;
}

interface QualityOverwrite {
    encode: VideoQuality;
    capture: VideoQuality;
    bitrateMax: number;
    bitrateMin: number;
}

interface StreamParameter {
    quality?: number;
    maxBitrate?: number;
    maxFrameRate?: number;
    maxResolution?: { type: unknown; width?: number; height?: number; };
}

interface WebRTCConnection {
    context: string;
    input?: { getVideoStream?(): MediaStream | null | undefined; };
    videoQualityManager: {
        goliveMaxQuality?: { bitrateMax?: number; };
        qualityOverwrite?: QualityOverwrite;
        setGoliveQuality(quality: { encode: VideoQuality; capture: VideoQuality; bitrateMax: number; }): void;
        setQualityOverwrite(quality: QualityOverwrite | undefined): void;
    };
    videoStreamParameters: StreamParameter[];
}

// Discord's own limits: the answer SDP video cap, the camera budget and the top Go Live budget
const SDP_VIDEO_BITRATE_KBPS = 2500;
const CAMERA_BITRATE_MIN = 2_500_000;
const CAMERA_BITRATE_MAX = 6_000_000;
const STREAM_BITRATE_MAX = 9_000_000;

// What the camera is asked for in max quality mode; the camera delivers its best mode up to this
const CAMERA_TARGET = { width: 1920, height: 1080, frameRate: 60 };

const isMaxQuality = () => settings.store.maxVideoQuality;

const readConstraint = (value: unknown) =>
    typeof value === "number" ? value : (value as ConstrainDoubleRange | undefined)?.ideal ?? (value as ConstrainDoubleRange | undefined)?.max;

// Runs after the WebRTC connection sets a screen input. It only passes width and height on, so the frame rate
// stays at the 30 FPS default and the max resolution and frame rate reported to the voice server stay 720p 30
// (that's the quality badge viewers see). Do what Discord's native connection does instead
export function syncGoLiveQuality(connection: WebRTCConnection, constraints: MediaTrackConstraints, highBitrate: number, lowBitrate: number) {
    try {
        const width = readConstraint(constraints.width);
        const height = readConstraint(constraints.height);
        const framerate = readConstraint(constraints.frameRate);
        if (!width || !height) return;

        const bitrateMax = height > 720 || (framerate ?? 0) > 30 ? highBitrate : lowBitrate;
        const quality = { width, height, framerate };
        connection.videoQualityManager.setGoliveQuality({ encode: quality, capture: quality, bitrateMax });

        const params = connection.videoStreamParameters;
        const main = params[Math.max(0, params.findIndex(p => p.quality === 100))];
        if (!main) return;

        main.maxResolution = { ...main.maxResolution!, width, height };
        if (framerate) main.maxFrameRate = framerate;
        main.maxBitrate = bitrateMax;
    } catch (err) {
        logger.error("Failed to sync the stream quality", err);
    }
}

const cameraBitrate = (width: number, height: number, framerate: number) =>
    Math.min(CAMERA_BITRATE_MAX, Math.max(CAMERA_BITRATE_MIN, Math.round(width * height * framerate * 0.1)));

// Runs at the start of every quality update. In max quality mode, pin encoding to the full size and frame rate of
// what is captured, so Discord stops scaling video down to viewers' tile sizes and stops cutting the camera's
// frame rate after 15 seconds of silence
export function applyMaxVideoQuality(connection: WebRTCConnection) {
    try {
        const manager = connection.videoQualityManager;
        if (!isMaxQuality()) {
            if (manager.qualityOverwrite) manager.setQualityOverwrite(undefined);
            return;
        }

        const track = connection.input?.getVideoStream?.()?.getVideoTracks()[0];
        if (!track || track.readyState !== "live") return;

        const { width, height, frameRate } = track.getSettings();
        if (!width || !height) return;

        const framerate = Math.round(frameRate || 30);
        const bitrateMax = connection.context === "stream" ? STREAM_BITRATE_MAX : cameraBitrate(width, height, framerate);
        const quality = { width, height, framerate };

        manager.setQualityOverwrite({ encode: quality, capture: quality, bitrateMax, bitrateMin: Math.round(bitrateMax / 4) });
    } catch (err) {
        logger.error("Failed to apply max video quality", err);
    }
}

// Discord's WebRTC answer SDP caps video at x-google-max-bitrate=2500 (kbps) for every connection, which holds
// video far below the bitrate Discord's own quality manager allows. Raise it to the budget actually in use
export function getVideoBitrateKbps(connection: Partial<WebRTCConnection> | undefined) {
    let bitrate: number | undefined;

    if (connection?.context === "stream") {
        bitrate = isMaxQuality() ? STREAM_BITRATE_MAX : connection.videoQualityManager?.goliveMaxQuality?.bitrateMax;
    } else if (connection?.context === "default" && isMaxQuality()) {
        bitrate = CAMERA_BITRATE_MAX;
    }

    return bitrate ? Math.max(SDP_VIDEO_BITRATE_KBPS, Math.round(bitrate / 1000)) : SDP_VIDEO_BITRATE_KBPS;
}

// Chromium starts its bandwidth estimate around 300 kbps and ramps up slowly, lowering the resolution meanwhile.
// Start raised video at Discord's usual video bitrate instead
export function getStartBitrateParam(maxBitrateKbps: number) {
    return maxBitrateKbps > SDP_VIDEO_BITRATE_KBPS ? `;x-google-start-bitrate=${SDP_VIDEO_BITRATE_KBPS}` : "";
}

// Discord asks the camera for 1280 pixels wide only. In max quality mode, ask for the camera's best mode
export function upgradeCameraConstraints(constraints: MediaStreamConstraints | undefined) {
    if (!constraints?.video || !isMaxQuality()) return constraints;

    const video = typeof constraints.video === "object" ? constraints.video : {};
    return {
        ...constraints,
        video: {
            ...video,
            width: { ideal: CAMERA_TARGET.width },
            height: { ideal: CAMERA_TARGET.height },
            frameRate: { ideal: CAMERA_TARGET.frameRate }
        }
    };
}
