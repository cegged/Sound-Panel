/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, SoundboardSound } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import {
    FluxDispatcher,
    GuildStore,
    IconUtils,
    MediaEngineStore,
    PermissionStore,
    RestAPI,
    SoundboardStore,
    UserSettingsActionCreators,
    UserStore,
    useStateFromStores
} from "@webpack/common";

import { isSelfMuted, mixerStore } from "../audio/mixer";
import { playClip } from "../audio/player";
import { settings } from "../settings";
import { logger } from "../utils/logger";
import { Native } from "../utils/native";
import { useStore } from "../utils/store";

const fetchSoundboardSounds: (options?: { disableAnalytics?: boolean; }) => Promise<unknown> =
    findByCodeLazy("SOUNDBOARD_FETCH_DEFAULT_SOUNDS");
const EmojiUtils: { getURL(surrogate: string): string | undefined; } = findByPropsLazy("getURL", "getEmojiColors");

const USE_SOUNDBOARD = 1n << 42n;
const USE_EXTERNAL_SOUNDS = 1n << 45n;
const DEFAULT_SOUNDS_GUILD = "0";

export interface SoundGroup {
    id: string;
    name: string;
    iconUrl?: string;
    sounds: SoundboardSound[];
}

export type SoundRoute =
    // Discord's own soundboard: everyone hears it, on every client
    | { kind: "soundboard"; }
    | { kind: "microphone"; reason?: string; }
    // Nobody else would hear it, so it's only previewed
    | { kind: "local"; reason: string; };

// Everything that decides where a sound plays, gathered once per render instead of once per sound
export interface SoundContext {
    channel?: Channel;
    muted: boolean;
    canUseSoundboard: boolean;
    canUseExternalSounds: boolean;
    hasNitro: boolean;
    micReady: boolean;
    preferMicrophone: boolean;
}

export const getSoundUrl = (soundId: string) => `https://cdn.discordapp.com/soundboard-sounds/${soundId}`;
export const getEmojiUrl = (emojiId: string) => `https://cdn.discordapp.com/emojis/${emojiId}.webp?size=48`;
// Discord's own artwork for unicode emoji, so sounds look the same as in its soundboard
export const getUnicodeEmojiUrl = (emoji: string) => EmojiUtils.getURL(emoji);

export async function loadSoundboardSounds() {
    try {
        await fetchSoundboardSounds({ disableAnalytics: true });
    } catch (err) {
        logger.error("Failed to fetch soundboard sounds", err);
    }
}

export function useSoundContext(channel: Channel | undefined): SoundContext {
    const muted = useStateFromStores([MediaEngineStore], isSelfMuted);
    const canUseSoundboard = useStateFromStores([PermissionStore], () => !channel?.guild_id || PermissionStore.can(USE_SOUNDBOARD, channel), [channel]);
    const canUseExternalSounds = useStateFromStores([PermissionStore], () => !channel?.guild_id || PermissionStore.can(USE_EXTERNAL_SOUNDS, channel), [channel]);
    const hasNitro = useStateFromStores([UserStore], () => !!UserStore.getCurrentUser()?.premiumType);
    const mixing = useStore(mixerStore, s => s.activeMixes > 0);
    const { transmit, serverSoundsThroughMic } = settings.use(["transmit", "serverSoundsThroughMic"]);

    return { channel, muted, canUseSoundboard, canUseExternalSounds, hasNitro, micReady: transmit && mixing, preferMicrophone: serverSoundsThroughMic };
}

// The same, read once, for a sound that plays while the panel may be closed
export function getSoundContext(channel: Channel): SoundContext {
    const { transmit, serverSoundsThroughMic } = settings.store;

    return {
        channel,
        muted: isSelfMuted(),
        canUseSoundboard: !channel.guild_id || PermissionStore.can(USE_SOUNDBOARD, channel),
        canUseExternalSounds: !channel.guild_id || PermissionStore.can(USE_EXTERNAL_SOUNDS, channel),
        hasNitro: !!UserStore.getCurrentUser()?.premiumType,
        micReady: transmit && mixerStore.get().activeMixes > 0,
        preferMicrophone: serverSoundsThroughMic
    };
}

function getSoundboardBlocker(sound: SoundboardSound, ctx: SoundContext) {
    if (!sound.available) return "This sound is unavailable";
    if (!ctx.canUseSoundboard) return "You can't use the soundboard in this channel";

    const external = sound.guildId !== DEFAULT_SOUNDS_GUILD && sound.guildId !== ctx.channel?.guild_id;
    if (external && !ctx.hasNitro) return "Sounds from other servers need Nitro";
    if (external && !ctx.canUseExternalSounds) return "Sounds from other servers aren't allowed here";

    return null;
}

export function getSoundRoute(sound: SoundboardSound, ctx: SoundContext): SoundRoute {
    if (!ctx.channel) return { kind: "local", reason: "Join a voice channel to play sounds for everyone" };
    if (ctx.muted) return { kind: "local", reason: "Unmute to play sounds for everyone" };

    const blocker = getSoundboardBlocker(sound, ctx);
    if (!blocker && !ctx.preferMicrophone) return { kind: "soundboard" };
    if (ctx.micReady) return { kind: "microphone", reason: blocker ?? undefined };

    return { kind: "local", reason: blocker ?? "Your microphone isn't carrying custom audio, see the status at the bottom" };
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

export const clipKey = (sound: SoundboardSound) => `server:${sound.soundId}`;

export async function playThroughMicrophone(sound: SoundboardSound) {
    const url = URL.createObjectURL(await downloadSoundboardSound(sound.soundId));
    try {
        await playClip({ key: clipKey(sound), url, volume: sound.volume });
    } finally {
        // The audio element holds on to the data while it plays
        URL.revokeObjectURL(url);
    }
}

// Discord's own favorites: the same stars as in its soundboard, saved with your account
export function setSoundboardFavorite(soundId: string, favorite: boolean) {
    const toggle = (ids: string[] = []) => favorite ? [...ids.filter(id => id !== soundId), soundId] : ids.filter(id => id !== soundId);

    UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync(
        "favoriteSoundboardSounds",
        (favorites: { soundIds?: string[]; orderedSoundIds?: string[]; }) => {
            favorites.soundIds = toggle(favorites.soundIds);
            // Discord also keeps the order favorites were added in, once it has started to
            if (favorites.orderedSoundIds?.length) favorites.orderedSoundIds = toggle(favorites.orderedSoundIds);
        },
        0 // INFREQUENT_USER_ACTION
    );
}

// The same request Discord's soundboard makes, except errors aren't swallowed
export async function playServerSound(sound: SoundboardSound, channel: Channel) {
    const body: Record<string, string | null> = {
        sound_id: sound.soundId,
        emoji_id: sound.emojiId,
        emoji_name: sound.emojiName
    };
    if (sound.guildId !== DEFAULT_SOUNDS_GUILD) body.source_guild_id = sound.guildId;

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
    const favoriteIds = SoundboardStore.getFavorites();
    const groups: SoundGroup[] = [];

    const favorites = [...soundsByGuild.values()].flat().filter(sound => favoriteIds.has(sound.soundId));
    if (favorites.length) groups.push({ id: "favorites", name: "Favorites", sounds: favorites });

    const guildGroups = [...soundsByGuild]
        .filter(([guildId, sounds]) => guildId !== DEFAULT_SOUNDS_GUILD && sounds.length)
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

    const defaults = soundsByGuild.get(DEFAULT_SOUNDS_GUILD);
    if (defaults?.length) groups.push({ id: "defaults", name: "Discord Defaults", sounds: defaults });

    return groups;
}
