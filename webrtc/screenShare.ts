/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MediaEngineStore } from "@webpack/common";

import { logger, showError } from "../utils/logger";
import { Native } from "../utils/native";
import { pickScreenSource, type ScreenShareChoice } from "./SourcePicker";

// Discord's desktop Go Live window picks screens and windows by their Electron source id, while the WebRTC engine
// only streams what it captured through getDisplayMedia itself. This captures the picked source for the engine.

interface GoLiveSource {
    desktopDescription: {
        id: string;
        soundshareId?: number | null;
        useLoopback?: boolean;
    };
    quality?: { resolution?: number; frameRate?: number; };
}

interface WebRTCEngine {
    getDesktopSource(constraints: MediaTrackConstraints, audio: boolean): Promise<string>;
    setGoLiveSource(source: GoLiveSource, context: string): void;
}

interface CaptureOptions {
    preset?: number;
    // Stream height, 0 meaning the source resolution
    resolution?: number;
    frameRate?: number;
    audio?: boolean;
}

interface CapturedInput extends CaptureOptions {
    sourceId: string;
}

const PRESET_DOCUMENTS = 2;

let originalGetDisplayMedia: MediaDevices["getDisplayMedia"] | null = null;
// Set while capturing a source Discord already picked, so getDisplayMedia skips our own picker
let pendingCapture: ScreenShareChoice & { contentHint: string; } | null = null;
// Engine input id -> what it was captured from, to re-capture it when the quality changes
const capturedInputs = new Map<string, CapturedInput>();
const capturing = new Set<string>();
let qualityChangeTimer: ReturnType<typeof setTimeout> | undefined;

const isElectronSourceId = (id: unknown): id is string => typeof id === "string" && /^(screen|window):/.test(id);

export function installScreenShareHook() {
    const devices = navigator.mediaDevices;
    if (!Native || !devices?.getDisplayMedia || originalGetDisplayMedia) return;

    const original = originalGetDisplayMedia = devices.getDisplayMedia;

    devices.getDisplayMedia = async function (constraints = {}) {
        const choice = pendingCapture ?? await pickScreenSource(!!constraints.audio);
        const contentHint = pendingCapture?.contentHint ?? "motion";
        pendingCapture = null;
        if (!choice) throw new DOMException("Screen share was cancelled", "NotAllowedError");

        await Native!.selectScreenSource(choice.id, choice.audio);

        // restrictOwnAudio leaves Discord's own playback out, so people in the call don't hear themselves
        const audio = choice.audio && constraints.audio
            ? { ...(typeof constraints.audio === "object" ? constraints.audio : {}), restrictOwnAudio: true }
            : false;

        const stream = await original.call(this, { ...constraints, audio } as DisplayMediaStreamOptions);

        // Screen captures otherwise keep their resolution and drop frames under load, which looks choppy
        stream.getVideoTracks().forEach(track => track.contentHint = contentHint);
        return stream;
    };
}

export function uninstallScreenShareHook() {
    if (!originalGetDisplayMedia) return;

    navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
    originalGetDisplayMedia = null;
}

// The engine reads these back to configure the encoder, so capture and encoding match
function getCaptureConstraints({ resolution, frameRate }: CaptureOptions) {
    const height = resolution || Math.round(screen.height * devicePixelRatio);
    const width = Math.round(height * screen.width / screen.height);
    const fps = frameRate || 30;

    return {
        width: { ideal: width, max: width },
        height: { ideal: height, max: height },
        frameRate: { ideal: fps, max: fps }
    };
}

async function capture(engine: WebRTCEngine, sourceId: string, options: CaptureOptions) {
    const constraints = getCaptureConstraints(options);
    logger.info(`Capturing ${sourceId} at ${constraints.width.max}x${constraints.height.max}, ${constraints.frameRate.max} FPS`);

    pendingCapture = {
        id: sourceId,
        audio: !!options.audio,
        contentHint: options.preset === PRESET_DOCUMENTS ? "detail" : "motion"
    };

    try {
        const inputId = await engine.getDesktopSource(constraints, !!options.audio);
        capturedInputs.set(inputId, { ...options, sourceId });
        return inputId;
    } finally {
        pendingCapture = null;
    }
}

function reportCaptureError(err: unknown) {
    showError("Couldn't capture the screen or window to stream", err);
}

// Runs before Discord creates the stream connection, like the web client does. Capturing later would add the
// video track to a connection that's already negotiated, and the stream starts out with no video.
export async function prepareDesktopSource<T extends { id?: string; }>(source: T, options: CaptureOptions) {
    if (!isElectronSourceId(source?.id)) return source;

    try {
        const engine = MediaEngineStore.getMediaEngine() as unknown as WebRTCEngine;
        return { ...source, id: await capture(engine, source.id, options) };
    } catch (err) {
        reportCaptureError(err);
        return source;
    }
}

async function recapture(engine: WebRTCEngine, source: GoLiveSource, context: string, options: CapturedInput) {
    if (capturing.has(options.sourceId)) return;

    capturing.add(options.sourceId);
    try {
        const inputId = await capture(engine, options.sourceId, options);
        engine.setGoLiveSource({ ...source, desktopDescription: { ...source.desktopDescription, id: inputId } }, context);
    } catch (err) {
        reportCaptureError(err);
    } finally {
        capturing.delete(options.sourceId);
    }
}

// Called with source ids the engine never captured: a new source (switching mid-stream),
// or the running stream's input with new quality settings
export function captureDesktopSource(engine: WebRTCEngine, source: GoLiveSource, context: string) {
    const { id, soundshareId, useLoopback } = source.desktopDescription;
    const { resolution, frameRate } = source.quality ?? {};

    if (isElectronSourceId(id)) {
        void recapture(engine, source, context, { sourceId: id, resolution, frameRate, audio: soundshareId != null || !!useLoopback });
        return;
    }

    const previous = capturedInputs.get(id);
    if (!previous || (resolution === previous.resolution && frameRate === previous.frameRate)) return;

    // Discord sends a burst of quality changes while a stream settles; only act on the last one
    clearTimeout(qualityChangeTimer);
    qualityChangeTimer = setTimeout(() => void recapture(engine, source, context, { ...previous, resolution, frameRate }), 1500);
}
