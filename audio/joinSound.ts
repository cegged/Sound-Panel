/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, SelectedChannelStore, showToast, SoundboardStore } from "@webpack/common";

import { getItem, refreshLibrary } from "../data/library";
import { getSoundContext, getSoundRoute, loadSoundboardSounds, playServerSound, playThroughMicrophone } from "../discord/soundboard";
import { type JoinSound, settings } from "../settings";
import { showError } from "../utils/logger";
import { isSelfMuted, mixerStore } from "./mixer";
import { playLibrarySound } from "./player";

const JOIN_DELAY = 500;
const MICROPHONE_WAIT = 3000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let joinedChannelId: string | null = null;

export const isLibraryJoinSound = (joinSound: JoinSound | null, id: string) =>
    joinSound?.type === "library" && joinSound.id === id;

export const isSoundboardJoinSound = (joinSound: JoinSound | null, soundId: string) =>
    joinSound?.type === "soundboard" && joinSound.soundId === soundId;

export function setJoinSound(joinSound: JoinSound | null, name: string) {
    settings.store.joinSound = joinSound;
    showToast({
        text: joinSound ? `"${name}" plays when you join a voice channel` : `"${name}" is no longer your join sound`,
        variant: "success"
    });
}

const notPlayed = (reason: string) => showToast({ text: `Your join sound didn't play: ${reason}` });

async function microphoneReady() {
    for (let waited = 0; mixerStore.get().activeMixes === 0 && waited < MICROPHONE_WAIT; waited += 100) await sleep(100);
    return settings.store.transmit && mixerStore.get().activeMixes > 0;
}

async function findSoundboardSound(soundId: string) {
    if (!SoundboardStore.getSoundById(soundId)) await loadSoundboardSounds();
    return SoundboardStore.getSoundById(soundId);
}

async function playJoinSound(channelId: string, joinSound: JoinSound) {
    await sleep(JOIN_DELAY);

    if (SelectedChannelStore.getVoiceChannelId() !== channelId) return;
    if (isSelfMuted()) return;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;

    if (joinSound.type === "soundboard") {
        const sound = await findSoundboardSound(joinSound.soundId);
        if (!sound) return notPlayed("the sound isn't on any of your servers anymore");

        let route = getSoundRoute(sound, getSoundContext(channel));
        if (route.kind === "local" && await microphoneReady()) route = getSoundRoute(sound, getSoundContext(channel));

        if (route.kind === "soundboard") return playServerSound(sound, channel);
        if (route.kind === "microphone") return playThroughMicrophone(sound);
        return notPlayed(route.reason);
    }

    await refreshLibrary();
    const item = getItem(joinSound.id);
    if (!item) return notPlayed("the sound was deleted");
    if (!await microphoneReady()) return notPlayed("your microphone isn't carrying your sounds, see the status at the bottom of the panel");

    await playLibrarySound(item);
}

export function onVoiceChannelSelect({ channelId }: { channelId?: string | null; }) {
    if (!channelId) joinedChannelId = null;
}

export function onRtcConnectionState({ state, context }: { state?: string; context?: string; }) {
    if (state !== "RTC_CONNECTED" || (context && context !== "default")) return;

    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId || channelId === joinedChannelId) return;
    joinedChannelId = channelId;

    const { joinSound } = settings.store;
    if (!joinSound || !ChannelStore.getChannel(channelId)?.guild_id) return;

    playJoinSound(channelId, joinSound).catch(err => showError("Couldn't play your join sound", err));
}
