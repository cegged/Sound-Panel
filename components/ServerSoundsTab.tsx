/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, SoundboardSound } from "@vencord/discord-types";
import { ContextMenuApi, GuildStore, Menu, showToast, SoundboardStore, Tooltip, useEffect, useState } from "@webpack/common";

import { isSoundboardJoinSound, setJoinSound } from "../audio/joinSound";
import { clipStore, playClip, stopClip } from "../audio/player";
import { addBlob } from "../data/library";
import {
    clipKey,
    downloadSoundboardSound,
    getEmojiUrl,
    getSoundGroups,
    getSoundRoute,
    getSoundUrl,
    getUnicodeEmojiUrl,
    loadSoundboardSounds,
    playServerSound,
    playThroughMicrophone,
    setSoundboardFavorite,
    type SoundContext,
    type SoundGroup,
    type SoundRoute,
    useSoundContext
} from "../discord/soundboard";
import { settings } from "../settings";
import { showError } from "../utils/logger";
import { useFluxUpdates, useStore } from "../utils/store";
import { cl, EmptyState, GroupHeader, matchesQuery, SearchBox, useCollapsedGroups, useGlassMenu } from "./common";
import { HeadphonesIcon, JoinSoundIcon, MicIcon, MusicNoteIcon, PlayIcon, SaveIcon, SoundboardIcon, SpeakerIcon, StarIcon } from "./icons";

function previewSound(sound: SoundboardSound) {
    playClip({ key: clipKey(sound), url: getSoundUrl(sound.soundId), volume: sound.volume, localOnly: true })
        .catch(err => showError("Couldn't preview this sound", err));
}

function playSound(sound: SoundboardSound, channel: Channel | undefined, route: SoundRoute) {
    switch (route.kind) {
        case "soundboard":
            playServerSound(sound, channel!).catch(err => showError(`Couldn't play "${sound.name}": ${err.message}`, err));
            break;
        case "microphone":
            playThroughMicrophone(sound).catch(err => showError(`Couldn't play "${sound.name}"`, err));
            break;
        case "local":
            if (channel) showToast({ text: `Only you will hear this: ${route.reason}` });
            previewSound(sound);
            break;
    }
}

function saveSound(sound: SoundboardSound, kind: "sound" | "music") {
    downloadSoundboardSound(sound.soundId)
        .then(blob => addBlob(blob, sound.name, kind))
        .then(() => showToast({ text: `Saved "${sound.name}" to ${kind === "music" ? "Music" : "My Sounds"}`, variant: "success" }))
        .catch(err => showError("Couldn't save this sound", err));
}

function describeRoute(sound: SoundboardSound, route: SoundRoute) {
    switch (route.kind) {
        case "soundboard": return sound.name;
        case "microphone": return `${sound.name}: plays through your microphone${route.reason ? ` (${route.reason})` : ""}`;
        case "local": return `${sound.name}: only you will hear it. ${route.reason}`;
    }
}

function SoundEmoji({ sound }: { sound: SoundboardSound; }) {
    const src = sound.emojiId ? getEmojiUrl(sound.emojiId) : sound.emojiName && getUnicodeEmojiUrl(sound.emojiName);
    if (src) return <img className={cl("emoji")} src={src} alt="" loading="lazy" />;
    return sound.emojiName ? <span className={cl("emoji")}>{sound.emojiName}</span> : <SpeakerIcon className={cl("emoji")} size={18} />;
}

function ServerSoundMenu({ sound, ctx, route }: { sound: SoundboardSound; ctx: SoundContext; route: SoundRoute; }) {
    const { joinSound } = settings.use(["joinSound"]);
    const glass = useGlassMenu();
    const isJoinSound = isSoundboardJoinSound(joinSound, sound.soundId);
    const favorite = SoundboardStore.isFavoriteSound(sound.soundId);

    return (
        <Menu.Menu navId="vc-soundpanel-server-sound" onClose={ContextMenuApi.closeContextMenu} aria-label={sound.name} {...glass}>
            <Menu.MenuItem
                id="vc-soundpanel-play"
                label="Play With Discord Soundboard"
                icon={PlayIcon}
                disabled={route.kind !== "soundboard"}
                action={() => playSound(sound, ctx.channel, { kind: "soundboard" })}
            />
            <Menu.MenuItem
                id="vc-soundpanel-play-mic"
                label="Play Through Microphone"
                icon={MicIcon}
                disabled={!ctx.channel || !ctx.micReady}
                action={() => playSound(sound, ctx.channel, { kind: "microphone" })}
            />
            <Menu.MenuItem
                id="vc-soundpanel-preview"
                label="Preview Only For Me"
                icon={HeadphonesIcon}
                action={() => previewSound(sound)}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-soundpanel-favorite"
                label={favorite ? "Remove from Favorites" : "Add to Favorites"}
                icon={StarIcon}
                action={() => setSoundboardFavorite(sound.soundId, !favorite)}
            />
            <Menu.MenuItem
                id="vc-soundpanel-join-sound"
                label={isJoinSound ? "Remove Join Sound" : "Set as Join Sound"}
                icon={JoinSoundIcon}
                action={() => setJoinSound(isJoinSound ? null : { type: "soundboard", soundId: sound.soundId, guildId: sound.guildId }, sound.name)}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-soundpanel-save-sound"
                label="Save to My Sounds"
                icon={SaveIcon}
                action={() => saveSound(sound, "sound")}
            />
            <Menu.MenuItem
                id="vc-soundpanel-save-music"
                label="Save to Music"
                icon={MusicNoteIcon}
                action={() => saveSound(sound, "music")}
            />
        </Menu.Menu>
    );
}

function ServerSoundTile({ sound, ctx, playing, joinSound }: { sound: SoundboardSound; ctx: SoundContext; playing: boolean; joinSound: boolean; }) {
    const route = getSoundRoute(sound, ctx);

    const onClick = () => {
        if (playing && !settings.store.allowOverlap) stopClip(clipKey(sound));
        else playSound(sound, ctx.channel, route);
    };

    return (
        <Tooltip text={joinSound ? `${describeRoute(sound, route)} · Join sound` : describeRoute(sound, route)}>
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    className={cl("tile", {
                        "tile-local": route.kind === "local",
                        "tile-discord": route.kind === "soundboard",
                        "tile-playing": playing || SoundboardStore.isPlayingSound(sound.soundId)
                    })}
                    onClick={onClick}
                    onContextMenu={e => ContextMenuApi.openContextMenu(e, () => <ServerSoundMenu sound={sound} ctx={ctx} route={route} />)}
                >
                    <SoundEmoji sound={sound} />
                    <span className={cl("tile-name")}>{sound.name}</span>
                    {joinSound && <JoinSoundIcon className={cl("tile-badge", "tile-badge-join")} size={14} />}
                    {route.kind === "microphone" && <MicIcon className={cl("tile-badge")} size={14} />}
                    {route.kind === "local" && <HeadphonesIcon className={cl("tile-badge")} size={14} />}
                </button>
            )}
        </Tooltip>
    );
}

const acronym = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 3).map(word => [...word][0]).join("");

function GroupIcon({ group }: { group: SoundGroup; }) {
    if (group.iconUrl) return <img className={cl("group-icon")} src={group.iconUrl} alt="" />;
    if (group.id === "favorites") return <span className={cl("group-icon", "group-icon-favorites")}><StarIcon size={14} /></span>;

    return (
        <span className={cl("group-icon", "group-icon-fallback")}>
            {group.id === "defaults" ? <SoundboardIcon size={10} /> : acronym(group.name)}
        </span>
    );
}

export function ServerSoundsTab({ channel }: { channel?: Channel; }) {
    useFluxUpdates([SoundboardStore, GuildStore]);
    const ctx = useSoundContext(channel);
    const playing = useStore(clipStore, s => s.playing);
    const { joinSound } = settings.use(["joinSound"]);
    const [query, setQuery] = useState("");
    const [collapsed, toggleGroup] = useCollapsedGroups();

    useEffect(() => {
        void loadSoundboardSounds();
    }, []);

    const groups = getSoundGroups()
        .map(group => ({ ...group, sounds: group.sounds.filter(sound => matchesQuery(sound.name, query)) }))
        .filter(group => group.sounds.length);

    const loading = SoundboardStore.isFetchingSounds() || !SoundboardStore.hasFetchedAllSounds();

    return (
        <div className={cl("tab")}>
            <div className={cl("toolbar")}>
                <SearchBox value={query} onChange={setQuery} placeholder="Search server sounds" />
            </div>
            {!channel && (
                <div className={cl("notice")}>Not in a voice channel. Clicking a sound plays a preview only you can hear.</div>
            )}
            <div className={cl("scroller")}>
                {groups.length === 0 ? (
                    <EmptyState
                        icon={<SoundboardIcon size={28} />}
                        title={loading ? "Loading sounds..." : query ? "No sounds match your search" : "No soundboard sounds available"}
                    />
                ) : groups.map(group => {
                    const isCollapsed = collapsed.has(group.id) && !query;

                    return (
                        <section key={group.id} className={cl("group")}>
                            <GroupHeader
                                icon={<GroupIcon group={group} />}
                                name={group.name}
                                count={group.sounds.length}
                                collapsed={isCollapsed}
                                onToggle={() => toggleGroup(group.id)}
                            />
                            {!isCollapsed && (
                                <div className={cl("grid")}>
                                    {group.sounds.map(sound => (
                                        <ServerSoundTile
                                            key={`${group.id}-${sound.soundId}`}
                                            sound={sound}
                                            ctx={ctx}
                                            playing={playing.includes(clipKey(sound))}
                                            joinSound={isSoundboardJoinSound(joinSound, sound.soundId)}
                                        />
                                    ))}
                                </div>
                            )}
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
