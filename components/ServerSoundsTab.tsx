/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { Channel, SoundboardSound } from "@vencord/discord-types";
import {
    ContextMenuApi,
    GuildStore,
    MediaEngineStore,
    Menu,
    PermissionStore,
    showToast,
    SoundboardStore,
    Tooltip,
    useEffect,
    useState
} from "@webpack/common";

import { mixerStore } from "../audio/mixer";
import { clipStore, playClip, stopClip } from "../audio/player";
import { addBlob } from "../data/library";
import {
    canUseMicrophone,
    downloadSoundboardSound,
    getEmojiUrl,
    getSoundGroups,
    getSoundRoute,
    getSoundUrl,
    loadSoundboardSounds,
    playServerSound,
    type SoundGroup,
    type SoundRoute
} from "../discord/soundboard";
import { settings } from "../settings";
import { useFluxStores, useStore } from "../utils/store";
import { cl, EmptyState, matchesQuery, SearchBox } from "./common";
import { ChevronIcon, HeadphonesIcon, MicIcon, MusicNoteIcon, PlayIcon, SaveIcon, ServerIcon, SpeakerIcon, StarIcon } from "./icons";

const logger = new Logger("SoundPanel");

const clipKey = (sound: SoundboardSound) => `server:${sound.soundId}`;

function reportError(message: string) {
    return (err: Error) => {
        logger.error(message, err);
        showToast({ text: `${message}: ${err.message}`, variant: "critical" });
    };
}

function previewSound(sound: SoundboardSound) {
    playClip({ key: clipKey(sound), url: getSoundUrl(sound.soundId), volume: sound.volume, localOnly: true })
        .catch(reportError("Couldn't preview this sound"));
}

async function playThroughMicrophone(sound: SoundboardSound) {
    const url = URL.createObjectURL(await downloadSoundboardSound(sound.soundId));
    try {
        await playClip({ key: clipKey(sound), url, volume: sound.volume });
    } finally {
        // The element keeps its own reference while it plays
        URL.revokeObjectURL(url);
    }
}

function playSound(sound: SoundboardSound, channel: Channel | undefined, route: SoundRoute) {
    switch (route.kind) {
        case "soundboard":
            playServerSound(sound, channel!).catch(reportError(`Couldn't play "${sound.name}"`));
            break;
        case "microphone":
            playThroughMicrophone(sound).catch(reportError(`Couldn't play "${sound.name}"`));
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
        .catch(reportError("Couldn't save this sound"));
}

function describeRoute(sound: SoundboardSound, route: SoundRoute) {
    switch (route.kind) {
        case "soundboard": return sound.name;
        case "microphone": return `${sound.name}: plays through your microphone${route.reason ? ` (${route.reason})` : ""}`;
        case "local": return `${sound.name}: only you will hear it. ${route.reason}`;
    }
}

function SoundEmoji({ sound }: { sound: SoundboardSound; }) {
    if (sound.emojiId) return <img className={cl("emoji")} src={getEmojiUrl(sound.emojiId)} alt="" loading="lazy" />;
    if (sound.emojiName) return <span className={cl("emoji")}>{sound.emojiName}</span>;
    return <span className={cl("emoji")}><SpeakerIcon size={16} /></span>;
}

function ServerSoundMenu({ sound, channel, route }: { sound: SoundboardSound; channel?: Channel; route: SoundRoute; }) {
    return (
        <Menu.Menu navId="vc-soundpanel-server-sound" onClose={ContextMenuApi.closeContextMenu} aria-label={sound.name}>
            <Menu.MenuItem
                id="vc-soundpanel-play"
                label="Play With Discord Soundboard"
                icon={PlayIcon}
                disabled={route.kind !== "soundboard"}
                action={() => playSound(sound, channel, { kind: "soundboard" })}
            />
            <Menu.MenuItem
                id="vc-soundpanel-play-mic"
                label="Play Through Microphone"
                icon={MicIcon}
                disabled={!channel || !canUseMicrophone()}
                action={() => playSound(sound, channel, { kind: "microphone" })}
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

function ServerSoundTile({ sound, channel, playing }: { sound: SoundboardSound; channel?: Channel; playing: boolean; }) {
    const route = getSoundRoute(sound, channel);
    const playingInVoice = SoundboardStore.isPlayingSound(sound.soundId);

    const onClick = () => {
        // With overlap off, clicking a sound that's already playing stops it
        if (playing && !settings.store.allowOverlap) stopClip(clipKey(sound));
        else playSound(sound, channel, route);
    };

    return (
        <Tooltip text={describeRoute(sound, route)}>
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    className={cl("tile", {
                        "tile-local": route.kind === "local",
                        "tile-playing": playing || playingInVoice
                    })}
                    onClick={onClick}
                    onContextMenu={e => ContextMenuApi.openContextMenu(e, () => (
                        <ServerSoundMenu sound={sound} channel={channel} route={route} />
                    ))}
                >
                    <SoundEmoji sound={sound} />
                    <span className={cl("tile-name")}>{sound.name}</span>
                    {route.kind === "microphone" && <span className={cl("tile-badge")}><MicIcon size={12} /></span>}
                </button>
            )}
        </Tooltip>
    );
}

function GroupIcon({ group }: { group: SoundGroup; }) {
    if (group.id === "favorites") return <StarIcon size={16} />;
    if (group.iconUrl) return <img className={cl("group-icon")} src={group.iconUrl} alt="" />;
    return <ServerIcon size={16} />;
}

export function ServerSoundsTab({ channel }: { channel?: Channel; }) {
    useFluxStores([SoundboardStore, GuildStore, MediaEngineStore, PermissionStore]);
    // Each sound's route depends on these, so re-render when they change
    useStore(mixerStore);
    settings.use(["transmit", "serverSoundsThroughMic"]);
    const { playing } = useStore(clipStore);
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
                    SoundboardStore.isFetchingSounds() || !SoundboardStore.hasFetchedAllSounds()
                        ? <EmptyState icon={<SpeakerIcon size={32} />} title="Loading sounds..." />
                        : <EmptyState icon={<SpeakerIcon size={32} />} title={query ? "No sounds match your search" : "No soundboard sounds available"} />
                ) : groups.map(group => {
                    const isCollapsed = collapsed.has(group.id) && !query;

                    return (
                        <section key={group.id} className={cl("group")}>
                            <button type="button" className={cl("group-header")} onClick={() => toggleGroup(group.id)} aria-expanded={!isCollapsed}>
                                <GroupIcon group={group} />
                                <span className={cl("group-name")}>{group.name}</span>
                                <span className={cl("group-count")}>{group.sounds.length}</span>
                                <span className={cl("chevron", { "chevron-collapsed": isCollapsed })}><ChevronIcon size={16} /></span>
                            </button>
                            {!isCollapsed && (
                                <div className={cl("grid")}>
                                    {group.sounds.map(sound => (
                                        <ServerSoundTile
                                            key={`${group.id}-${sound.soundId}`}
                                            sound={sound}
                                            channel={channel}
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
