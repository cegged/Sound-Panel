/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import { MediaEngineStore } from "@webpack/common";

import { settings } from "../settings";
import { logger } from "../utils/logger";
import { createStore } from "../utils/store";
import { usesDesktopWebRTC } from "../webrtc/engine";
import { upgradeCameraConstraints } from "../webrtc/quality";

export const MAX_VOICE_VOLUME = 150;

export const mixerStore = createStore({ activeMixes: 0 });

let context: AudioContext | null = null;
let voiceBus: GainNode;
let localBus: GainNode;
let originalGetUserMedia: MediaDevices["getUserMedia"] | null = null;
let forcingInput = false;

export const isSelfMuted = () => MediaEngineStore.isSelfMute() || MediaEngineStore.isSelfDeaf();

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

        const limiter = createLimiter(context);
        localBus.connect(limiter);
        limiter.connect(context.destination);

        applyVolumes();
        applyOutputDevice();
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

export async function routeToOutputDevice(target: AudioContext | HTMLMediaElement) {
    const deviceId = MediaEngineStore.getOutputDeviceId();

    try {
        await (target as { setSinkId?(id: string): Promise<void>; }).setSinkId?.(!deviceId || deviceId === "default" ? "" : deviceId);
    } catch { }
}

export function applyOutputDevice() {
    if (context) void routeToOutputDevice(context);
}

async function mixWithMicrophone(microphone: MediaStream) {
    const ctx = getAudioContext();
    if (ctx.state !== "running") await Promise.race([ctx.resume(), sleep(500)]);

    if (ctx.state !== "running") {
        logger.warn("Audio context isn't running, not mixing the microphone");
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
    const devices = navigator.mediaDevices;
    if (!devices || originalGetUserMedia) return;

    const original = originalGetUserMedia = devices.getUserMedia;

    devices.getUserMedia = async function (constraints) {
        const stream = await original.call(this, usesDesktopWebRTC() ? upgradeCameraConstraints(constraints) : constraints);
        if (!constraints?.audio || constraints.video) return stream;

        try {
            return await mixWithMicrophone(stream);
        } catch (err) {
            logger.error("Failed to mix the microphone", err);
            return stream;
        }
    };
}

export function uninstallMicrophoneHook() {
    if (!originalGetUserMedia) return;

    navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    originalGetUserMedia = null;
}

export function setPlaybackActive(active: boolean) {
    const { transmit, holdPushToTalk } = settings.store;
    const force = active && transmit && holdPushToTalk && MediaEngineStore.getMode() === "PUSH_TO_TALK";
    if (force === forcingInput) return;

    forcingInput = force;
    try {
        MediaEngineStore.getMediaEngine().eachConnection(conn => conn.setForceAudioInput?.(force), "default");
    } catch (err) {
        logger.error("Failed to toggle forced audio input", err);
    }
}
