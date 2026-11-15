/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import { MediaEngineStore } from "@webpack/common";

import { settings } from "../settings";
import { createStore } from "../utils/store";
import { upgradeCameraConstraints } from "../video/quality";

// Audio graph:
//   clip / music ─┬─> voiceBus ─┐
//                 │             ├─> limiter ──> mixed microphone stream(s) ──> Discord (WebRTC)
//   microphone ───┼─────────────┘
//                 └─> localBus ──> limiter ──> speakers

const logger = new Logger("SoundPanel");

let context: AudioContext | null = null;
let voiceBus: GainNode;
let localBus: GainNode;
let originalGetUserMedia: MediaDevices["getUserMedia"] | null = null;
let forcingInput = false;
// Discord picks its voice engine once at startup, so the setting only counts as of then
let webrtcEngineActive = !IS_DISCORD_DESKTOP;

export const isWebRTCEngineActive = () => webrtcEngineActive;

// activeMixes: microphone streams currently carrying our audio to Discord
export const mixerStore = createStore({ activeMixes: 0 });

type SinkTarget = { setSinkId(id: string): Promise<void>; };

export const MAX_VOICE_VOLUME = 150;

// Brick-wall limiter: full-scale files at boosted volume would otherwise clip, which sounds like crackling
function createLimiter(ctx: AudioContext) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    return limiter;
}

export function getAudioContext() {
    if (!context) {
        context = new AudioContext({ latencyHint: "interactive" });
        voiceBus = context.createGain();
        localBus = context.createGain();

        const localLimiter = createLimiter(context);
        localBus.connect(localLimiter);
        localLimiter.connect(context.destination);

        applyVolumes();
        void applyOutputDevice();
    }

    if (context.state === "suspended") context.resume().catch(() => { });
    return context;
}

export function connectToOutputs(node: AudioNode) {
    getAudioContext();
    node.connect(localBus);
    node.connect(voiceBus);
}

export function applyVolumes() {
    if (!context) return;

    const { transmit, voiceVolume, localVolume } = settings.store;
    voiceBus.gain.value = transmit ? Math.min(voiceVolume, MAX_VOICE_VOLUME) / 100 : 0;
    localBus.gain.value = localVolume / 100;
}

function getOutputDeviceId() {
    const deviceId = MediaEngineStore.getOutputDeviceId();
    return !deviceId || deviceId === "default" ? "" : deviceId;
}

// Sends an audio context or element to the output device selected in Discord
export async function routeToOutputDevice(target: object) {
    if (!("setSinkId" in target)) return;

    try {
        await (target as SinkTarget).setSinkId(getOutputDeviceId());
    } catch {
        // The native voice engine uses its own device ids which the browser doesn't know about
    }
}

export async function applyOutputDevice() {
    if (context) await routeToOutputDevice(context);
}

async function mixWithMicrophone(microphone: MediaStream) {
    const ctx = getAudioContext();
    if (ctx.state !== "running") await Promise.race([ctx.resume(), sleep(500)]);

    // Never hand Discord a silent stream; fall back to the plain microphone instead
    if (ctx.state !== "running") {
        logger.warn("Audio context is not running, microphone will not be mixed");
        return microphone;
    }

    const source = ctx.createMediaStreamSource(microphone);
    const limiter = createLimiter(ctx);
    const destination = ctx.createMediaStreamDestination();
    source.connect(limiter);
    voiceBus.connect(limiter);
    limiter.connect(destination);

    const [track] = destination.stream.getAudioTracks();
    const stopTrack = track.stop.bind(track);
    let stopped = false;

    track.stop = () => {
        stopTrack();
        if (stopped) return;

        stopped = true;
        microphone.getTracks().forEach(t => t.stop());
        source.disconnect();
        voiceBus.disconnect(limiter);
        limiter.disconnect();
        mixerStore.set({ activeMixes: mixerStore.get().activeMixes - 1 });
    };

    mixerStore.set({ activeMixes: mixerStore.get().activeMixes + 1 });
    return destination.stream;
}

export function installMicrophoneHook() {
    webrtcEngineActive = !IS_DISCORD_DESKTOP || settings.store.webrtcEngine;

    const devices = navigator.mediaDevices;
    if (!devices || originalGetUserMedia) return;

    const original = originalGetUserMedia = devices.getUserMedia;

    devices.getUserMedia = async function (constraints) {
        const request = IS_DISCORD_DESKTOP && webrtcEngineActive ? upgradeCameraConstraints(constraints) : constraints;
        const stream = await original.call(this, request);
        if (!constraints?.audio || constraints.video) return stream;

        try {
            return await mixWithMicrophone(stream);
        } catch (err) {
            logger.error("Failed to mix microphone", err);
            return stream;
        }
    };
}

export function uninstallMicrophoneHook() {
    if (!originalGetUserMedia) return;

    navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    originalGetUserMedia = null;
}

// Keeps Push to Talk users transmitting while our audio plays
export function setPlaybackActive(active: boolean) {
    const { transmit, holdPushToTalk } = settings.store;
    const shouldForce = active && transmit && holdPushToTalk && MediaEngineStore.getMode() === "PUSH_TO_TALK";
    if (shouldForce === forcingInput) return;

    forcingInput = shouldForce;
    try {
        MediaEngineStore.getMediaEngine().eachConnection(conn => conn.setForceAudioInput?.(shouldForce), "default");
    } catch (err) {
        logger.error("Failed to toggle forced audio input", err);
    }
}
