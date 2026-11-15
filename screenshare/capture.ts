/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { MediaEngineStore, showToast } from "@webpack/common";

import { Native } from "../utils/native";
import { pickScreenSource, type ScreenShareChoice } from "./SourcePicker";

const logger = new Logger("SoundPanel");

type ContentHint = "motion" | "detail";

interface CaptureChoice extends ScreenShareChoice {
    contentHint: ContentHint;
}

let originalGetDisplayMedia: MediaDevices["getDisplayMedia"] | null = null;
// Source already chosen in Discord's own Go Live window, so the next capture skips our picker
let presetChoice: CaptureChoice | null = null;

export function installScreenShareHook() {
    const devices = navigator.mediaDevices;
    if (!Native || !devices?.getDisplayMedia || originalGetDisplayMedia) return;

    const original = originalGetDisplayMedia = devices.getDisplayMedia;

    devices.getDisplayMedia = async function (constraints = {}) {
        const picked = presetChoice ?? await pickScreenSource(!!constraints.audio);
        presetChoice = null;
        if (!picked) throw new DOMException("Screen share was cancelled", "NotAllowedError");

        const choice: CaptureChoice = { contentHint: "motion", ...picked };

        // The main process hands this source to Chromium when it asks for one
        await Native!.selectScreenSource(choice.id, choice.audio);

        const audio = choice.audio && constraints.audio
            ? {
                ...(typeof constraints.audio === "object" ? constraints.audio : {}),
                // Leave out Discord's own playback (other people's voices) so they don't hear themselves
                restrictOwnAudio: true
            }
            : false;

        const stream = await original.call(this, { ...constraints, audio } as DisplayMediaStreamOptions);

        // Screen captures default to keeping resolution and dropping frames under load, which looks choppy.
        // "motion" keeps the frame rate (Discord's "smoother video"), "detail" keeps text sharp ("clearer text")
        stream.getVideoTracks().forEach(track => track.contentHint = choice.contentHint);

        return stream;
    };
}

export function uninstallScreenShareHook() {
    if (!originalGetDisplayMedia) return;

    navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
    originalGetDisplayMedia = null;
}

// On desktop, Discord's Go Live window picks a screen or window by its Electron source id and passes that id on.
// The WebRTC engine only streams inputs it captured itself through getDisplayMedia, keyed by its own input id.

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
    // Discord's stream preset: 1 is "smoother video", 2 is "clearer text"
    preset?: number;
    // Stream height in pixels, 0 for the source resolution
    resolution?: number;
    frameRate?: number;
    audio?: boolean;
}

const PRESET_DOCUMENTS = 2;
const DEFAULT_FRAME_RATE = 30;

const isCapturableId = (id: unknown): id is string => typeof id === "string" && /^(screen|window):/.test(id);

// What each engine input was captured from, so quality changes during a stream can re-capture it
interface CapturedInput {
    sourceId: string;
    audio: boolean;
    preset?: number;
    resolution?: number;
    frameRate?: number;
}

const capturedInputs = new Map<string, CapturedInput>();

// Capture at the size and frame rate Discord picked for the stream. The engine reads these constraints back
// to configure the encoder, so capture and encoding stay in sync
function captureConstraints({ resolution, frameRate }: CaptureOptions) {
    const height = resolution || Math.round(screen.height * devicePixelRatio);
    const width = Math.round(height * screen.width / screen.height);
    const fps = frameRate || DEFAULT_FRAME_RATE;

    return {
        width: { ideal: width, max: width },
        height: { ideal: height, max: height },
        frameRate: { ideal: fps, max: fps }
    };
}

async function capture(engine: WebRTCEngine, id: string, options: CaptureOptions) {
    const constraints = captureConstraints(options);
    logger.info(`Capturing ${id} at ${constraints.width.max}x${constraints.height.max}, ${constraints.frameRate.max} FPS`);

    presetChoice = {
        id,
        audio: !!options.audio,
        contentHint: options.preset === PRESET_DOCUMENTS ? "detail" : "motion"
    };
    try {
        const inputId = await engine.getDesktopSource(constraints, !!options.audio);
        capturedInputs.set(inputId, {
            sourceId: id,
            audio: !!options.audio,
            preset: options.preset,
            resolution: options.resolution,
            frameRate: options.frameRate
        });
        return inputId;
    } finally {
        presetChoice = null;
    }
}

function reportCaptureError(err: unknown) {
    logger.error("Failed to capture the screen share source", err);
    showToast({ text: "Couldn't capture the screen or window to stream", variant: "critical" });
}

// Runs in startStreamWithSource, before the stream connection exists. Capturing this early lets the video track
// join the connection's first negotiation, so it's sent on the SSRC the voice server assigned and viewers expect.
export async function prepareDesktopSource<T extends { id?: string; }>(source: T, options: CaptureOptions) {
    if (!isCapturableId(source?.id)) return source;

    try {
        const engine = MediaEngineStore.getMediaEngine() as unknown as WebRTCEngine;
        const inputId = await capture(engine, source.id, options);
        return { ...source, id: inputId };
    } catch (err) {
        reportCaptureError(err);
        return source;
    }
}

const capturing = new Set<string>();
// Discord sends a burst of quality updates while a stream settles; wait for it to finish before re-capturing
const QUALITY_CHANGE_DELAY_MS = 1500;
let qualityChangeTimer: ReturnType<typeof setTimeout> | null = null;

async function recapture(engine: WebRTCEngine, source: GoLiveSource, context: string, options: CaptureOptions & { sourceId: string; }) {
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

// Handles source ids the engine never captured: a new Electron source (switching sources mid-stream),
// or the running stream's own input with new quality settings (changing quality mid-stream)
export function captureDesktopSource(engine: WebRTCEngine, source: GoLiveSource, context: string) {
    const { id, soundshareId, useLoopback } = source.desktopDescription;
    const resolution = source.quality?.resolution;
    const frameRate = source.quality?.frameRate;

    if (isCapturableId(id)) {
        void recapture(engine, source, context, { sourceId: id, resolution, frameRate, audio: soundshareId != null || !!useLoopback });
        return;
    }

    const previous = capturedInputs.get(id);
    // Discord repeats the current settings at times; only re-capture when the quality actually changed
    if (!previous || (resolution === previous.resolution && frameRate === previous.frameRate)) return;

    if (qualityChangeTimer) clearTimeout(qualityChangeTimer);
    qualityChangeTimer = setTimeout(() => {
        qualityChangeTimer = null;
        void recapture(engine, source, context, { ...previous, resolution, frameRate });
    }, QUALITY_CHANGE_DELAY_MS);
}
