/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DownArrow, StarFilled } from "@components/Icons";
import type { Channel, SoundboardSound } from "@vencord/discord-types";
import { ContextMenuApi, GuildStore, Menu, showToast, SoundboardStore, Tooltip, useEffect, useState } from "@webpack/common";

import { clipStore, playClip, stopClip } from "../audio/player";
import { addBlob } from "../data/library";
import {
    downloadSoundboardSound,
    getEmojiUrl,
    getSoundGroups,
    getSoundRoute,
    getSoundUrl,
    getUnicodeEmojiUrl,
    loadSoundboardSounds,
    playServerSound,
    type SoundContext,
    type SoundGroup,
    type SoundRoute,
    useSoundContext
} from "../discord/soundboard";
import { settings } from "../settings";
import { showError } from "../utils/logger";
import { useFluxUpdates, useStore } from "../utils/store";
import { cl, EmptyState, matchesQuery, SearchBox } from "./common";
import { HeadphonesIcon, MicIcon, MusicNoteIcon, PlayIcon, SaveIcon, SoundboardIcon, SpeakerIcon } from "./icons";

const clipKey = (sound: SoundboardSound) => `server:${sound.soundId}`;

function previewSound(sound: SoundboardSound) {
    playClip({ key: clipKey(sound), url: getSoundUrl(sound.soundId), volume: sound.volume, localOnly: true })
        .catch(err => showError("Couldn't preview this sound", err));
}

async function playThroughMicrophone(sound: SoundboardSound) {
    const url = URL.createObjectURL(await downloadSoundboardSound(sound.soundId));
    try {
        await playClip({ key: clipKey(sound), url, volume: sound.volume });
    } finally {
        // The audio element holds on to the data while it plays
        URL.revokeObjectURL(url);
    }
}

function playSound(sound: SoundboardSound, channel: Channel | undefined, route: SoundRoute) {
    switch (route.kind) {
        case "soundboard":
            // Discord's error says why, e.g. a missing permission
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
    return sound.emojiName ? <span className={cl("emoji")}>{sound.emojiName}</span> : <SpeakerIcon size={16} />;
}

function ServerSoundMenu({ sound, ctx, route }: { sound: SoundboardSound; ctx: SoundContext; route: SoundRoute; }) {
    return (
        <Menu.Menu navId="vc-soundpanel-server-sound" onClose={ContextMenuApi.closeContextMenu} aria-label={sound.name}>
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

function ServerSoundTile({ sound, ctx, playing }: { sound: SoundboardSound; ctx: SoundContext; playing: boolean; }) {
    const route = getSoundRoute(sound, ctx);

    const onClick = () => {
        if (playing && !settings.store.allowOverlap) stopClip(clipKey(sound));
        else playSound(sound, ctx.channel, route);
    };

    return (
        <Tooltip text={describeRoute(sound, route)}>
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    className={cl("tile", {
                        "tile-local": route.kind === "local",
                        "tile-playing": playing || SoundboardStore.isPlayingSound(sound.soundId)
                    })}
                    onClick={onClick}
                    onContextMenu={e => ContextMenuApi.openContextMenu(e, () => <ServerSoundMenu sound={sound} ctx={ctx} route={route} />)}
                >
                    <span className={cl("tile-icon")}><SoundEmoji sound={sound} /></span>
                    <span className={cl("tile-name")}>{sound.name}</span>
                    {route.kind === "microphone" && <span className={cl("tile-badge")}><MicIcon size={12} /></span>}
                </button>
            )}
        </Tooltip>
    );
}

const acronym = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 3).map(word => [...word][0]).join("");

function GroupIcon({ group }: { group: SoundGroup; }) {
    if (group.iconUrl) return <img className={cl("group-icon")} src={group.iconUrl} alt="" />;
    if (group.id === "favorites") return <span className={cl("group-icon", "group-icon-favorites")}><StarFilled width={12} height={12} /></span>;

    return (
        <span className={cl("group-icon", "group-icon-fallback")}>
            {group.id === "defaults" ? <SoundboardIcon size={12} /> : acronym(group.name)}
        </span>
    );
}

export function ServerSoundsTab({ channel }: { channel?: Channel; }) {
    useFluxUpdates([SoundboardStore, GuildStore]);
    const ctx = useSoundContext(channel);
    const playing = useStore(clipStore, s => s.playing);
    const [query, setQuery] = useState("");
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

    useEffect(() => {
        void loadSoundboardSounds();
    }, []);

    const groups = getSoundGroups()
        .map(group => ({ ...group, sounds: group.sounds.filter(sound => matchesQuery(sound.name, query)) }))
        .filter(group => group.sounds.length);

    const toggleGroup = (id: string) => setCollapsed(prev => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
    });

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
                            <button type="button" className={cl("group-header")} onClick={() => toggleGroup(group.id)} aria-expanded={!isCollapsed}>
                                <GroupIcon group={group} />
                                <span className={cl("group-name")}>{group.name}</span>
                                <span className={cl("group-count")}>{group.sounds.length}</span>
                                <span className={cl("chevron", { "chevron-collapsed": isCollapsed })}><DownArrow width={16} height={16} /></span>
                            </button>
                            {!isCollapsed && (
                                <div className={cl("grid")}>
                                    {group.sounds.map(sound => (
                                        <ServerSoundTile
                                            key={`${group.id}-${sound.soundId}`}
                                            sound={sound}
                                            ctx={ctx}
                                            playing={playing.includes(clipKey(sound))}
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
