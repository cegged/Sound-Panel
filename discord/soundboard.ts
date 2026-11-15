/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { Channel, SoundboardSound } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import {
    ChannelStore,
    FluxDispatcher,
    GuildStore,
    IconUtils,
    MediaEngineStore,
    PermissionStore,
    RestAPI,
    SelectedChannelStore,
    SoundboardStore,
    UserStore
} from "@webpack/common";

import { mixerStore } from "../audio/mixer";
import { settings } from "../settings";
import { Native } from "../utils/native";

const logger = new Logger("SoundPanel");

const fetchSoundboardSounds: (options?: { disableAnalytics?: boolean; }) => Promise<unknown> =
    findByCodeLazy("SOUNDBOARD_FETCH_DEFAULT_SOUNDS");

const USE_SOUNDBOARD = 1n << 42n;
const USE_EXTERNAL_SOUNDS = 1n << 45n;

export const DEFAULT_SOUNDS_GUILD_ID = "0";

export interface SoundGroup {
    id: string;
    name: string;
    iconUrl?: string;
    sounds: SoundboardSound[];
}

export const getSoundUrl = (soundId: string) => `https://cdn.discordapp.com/soundboard-sounds/${soundId}`;
export const getEmojiUrl = (emojiId: string) => `https://cdn.discordapp.com/emojis/${emojiId}.webp?size=48`;

export async function loadSoundboardSounds() {
    try {
        await fetchSoundboardSounds({ disableAnalytics: true });
    } catch (err) {
        logger.error("Failed to fetch soundboard sounds", err);
    }
}

export function getVoiceChannel(): Channel | undefined {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    return channelId ? ChannelStore.getChannel(channelId) : undefined;
}

// Returns why Discord's own soundboard can't play the sound in this channel, or null if it can
function getSoundboardBlocker(sound: SoundboardSound, channel: Channel): string | null {
    if (!sound.available) return "This sound is unavailable";

    const isExternal = sound.guildId !== DEFAULT_SOUNDS_GUILD_ID && sound.guildId !== channel.guild_id;

    if (channel.guild_id && !PermissionStore.can(USE_SOUNDBOARD, channel)) return "You can't use the soundboard in this channel";
    if (isExternal && !UserStore.getCurrentUser()?.premiumType) return "Sounds from other servers need Nitro";
    if (isExternal && channel.guild_id && !PermissionStore.can(USE_EXTERNAL_SOUNDS, channel)) return "Sounds from other servers aren't allowed here";

    return null;
}

export type SoundRoute =
    // Discord's soundboard: everyone hears it on every client, with the soundboard animation
    | { kind: "soundboard"; }
    // Mixed into your microphone like your own sounds
    | { kind: "microphone"; reason?: string; }
    // Nobody else can hear it right now, so it's only previewed for you
    | { kind: "local"; reason: string; };

export const canUseMicrophone = () => settings.store.transmit && mixerStore.get().activeMixes > 0;

export function getSoundRoute(sound: SoundboardSound, channel: Channel | undefined): SoundRoute {
    if (!channel) return { kind: "local", reason: "Join a voice channel to play sounds for everyone" };
    if (MediaEngineStore.isSelfMute() || MediaEngineStore.isSelfDeaf()) return { kind: "local", reason: "Unmute to play sounds for everyone" };

    const blocker = getSoundboardBlocker(sound, channel);
    if (!blocker && !settings.store.serverSoundsThroughMic) return { kind: "soundboard" };
    if (canUseMicrophone()) return { kind: "microphone", reason: blocker ?? undefined };

    return { kind: "local", reason: blocker ?? "Your microphone isn't carrying custom audio. Check the status at the bottom of the panel" };
}

const soundBlobs = new Map<string, Promise<Blob>>();

async function fetchSoundBlob(soundId: string) {
    const url = getSoundUrl(soundId);

    if (Native) {
        const { type, data } = await Native.downloadSoundboardSound(url);
        return new Blob([data], { type });
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
    return res.blob();
}

export function downloadSoundboardSound(soundId: string) {
    let blob = soundBlobs.get(soundId);
    if (!blob) {
        blob = fetchSoundBlob(soundId);
        blob.catch(() => soundBlobs.delete(soundId));
        soundBlobs.set(soundId, blob);
    }
    return blob;
}

// Same request Discord's soundboard makes, but the error is surfaced instead of swallowed
export async function playServerSound(sound: SoundboardSound, channel: Channel) {
    const body: Record<string, string | null> = {
        sound_id: sound.soundId,
        emoji_id: sound.emojiId,
        emoji_name: sound.emojiName
    };
    if (sound.guildId !== DEFAULT_SOUNDS_GUILD_ID) body.source_guild_id = sound.guildId;

    try {
        await RestAPI.post({ url: `/channels/${channel.id}/send-soundboard-sound`, body });
    } catch (err: any) {
        logger.error("Discord rejected the soundboard sound", err);
        throw new Error(err?.body?.message ?? `Request failed${err?.status ? ` (${err.status})` : ""}`);
    }

    FluxDispatcher.dispatch({ type: "GUILD_SOUNDBOARD_SOUND_PLAY_LOCALLY", sound, channelId: channel.id });
    FluxDispatcher.dispatch({ type: "SOUNDBOARD_TRACK_USAGE", soundId: sound.soundId });
}

export function getSoundGroups(): SoundGroup[] {
    const soundsByGuild = SoundboardStore.getSounds();
    const allSounds = [...soundsByGuild.values()].flat();
    const favoriteIds = SoundboardStore.getFavorites();
    const groups: SoundGroup[] = [];

    const favorites = allSounds.filter(sound => favoriteIds.has(sound.soundId));
    if (favorites.length) groups.push({ id: "favorites", name: "Favorites", sounds: favorites });

    const guildGroups = [...soundsByGuild.entries()]
        .filter(([guildId, sounds]) => guildId !== DEFAULT_SOUNDS_GUILD_ID && sounds.length)
        .map(([guildId, sounds]) => {
            const guild = GuildStore.getGuild(guildId);
            return {
                id: guildId,
                name: guild?.name ?? "Unknown Server",
                iconUrl: guild?.icon ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 32 }) ?? undefined : undefined,
                sounds
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    groups.push(...guildGroups);

    const defaults = soundsByGuild.get(DEFAULT_SOUNDS_GUILD_ID);
    if (defaults?.length) groups.push({ id: DEFAULT_SOUNDS_GUILD_ID, name: "Discord Defaults", sounds: defaults });

    return groups;
}
