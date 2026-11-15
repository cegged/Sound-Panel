/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { showToast, useState } from "@webpack/common";

import {
    cycleRepeatMode,
    musicStore,
    playTrack,
    seekMusic,
    skipTrack,
    toggleMusic,
    toggleShuffle
} from "../audio/player";
import { LibraryItem, updateItem, useLibrary } from "../data/library";
import { settings } from "../settings";
import { formatTime, useStore } from "../utils/store";
import { cl, EmptyState, FileDropZone, matchesQuery, RangeSlider, RenameInput, SearchBox, UploadButton } from "./common";
import {
    MusicNoteIcon,
    NextIcon,
    PauseIcon,
    PlayIcon,
    PreviousIcon,
    RepeatIcon,
    RepeatOneIcon,
    ShuffleIcon
} from "./icons";
import { openLibraryItemMenu } from "./LibraryItemMenu";

const logger = new Logger("SoundPanel");

function run(action: () => Promise<unknown>) {
    action().catch(err => {
        logger.error("Music action failed", err);
        showToast({ text: "Couldn't play this track", variant: "critical" });
    });
}

function NowPlaying({ tracks }: { tracks: LibraryItem[]; }) {
    const { currentId, playing, position, duration } = useStore(musicStore);
    const { repeatMode, shuffle, musicVolume } = settings.use(["repeatMode", "shuffle", "musicVolume"]);
    const current = tracks.find(track => track.id === currentId);
    const totalDuration = duration || current?.duration || 0;

    return (
        <div className={cl("now-playing")}>
            <div className={cl("now-playing-info")}>
                <div className={cl("now-playing-art", { "now-playing-art-active": playing })}>
                    <MusicNoteIcon size={22} />
                </div>
                <div className={cl("now-playing-text")}>
                    <div className={cl("now-playing-title")}>{current?.name ?? "Nothing playing"}</div>
                    <div className={cl("now-playing-subtitle")}>
                        {current ? `${tracks.indexOf(current) + 1} of ${tracks.length}` : `${tracks.length} track${tracks.length === 1 ? "" : "s"} in your library`}
                    </div>
                </div>
            </div>

            <div className={cl("seek")}>
                <span className={cl("time")}>{formatTime(position)}</span>
                <RangeSlider
                    label="Seek"
                    value={Math.min(position, totalDuration)}
                    max={totalDuration || 1}
                    step={0.1}
                    onChange={seekMusic}
                />
                <span className={cl("time")}>{formatTime(totalDuration)}</span>
            </div>

            <div className={cl("transport")}>
                <button
                    type="button"
                    className={cl("icon-button", { "icon-button-active": shuffle })}
                    aria-label="Shuffle"
                    aria-pressed={shuffle}
                    title={shuffle ? "Shuffle on" : "Shuffle off"}
                    onClick={toggleShuffle}
                >
                    <ShuffleIcon size={18} />
                </button>
                <button type="button" className={cl("icon-button")} aria-label="Previous" title="Previous" onClick={() => run(() => skipTrack(-1))}>
                    <PreviousIcon size={22} />
                </button>
                <button
                    type="button"
                    className={cl("play-button")}
                    aria-label={playing ? "Pause" : "Play"}
                    disabled={!tracks.length}
                    onClick={() => run(toggleMusic)}
                >
                    {playing ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
                </button>
                <button type="button" className={cl("icon-button")} aria-label="Next" title="Next" onClick={() => run(() => skipTrack(1))}>
                    <NextIcon size={22} />
                </button>
                <button
                    type="button"
                    className={cl("icon-button", { "icon-button-active": repeatMode !== "off" })}
                    aria-label="Repeat"
                    title={repeatMode === "one" ? "Repeat one" : repeatMode === "all" ? "Repeat all" : "Repeat off"}
                    onClick={cycleRepeatMode}
                >
                    {repeatMode === "one" ? <RepeatOneIcon size={18} /> : <RepeatIcon size={18} />}
                </button>
            </div>

            <label className={cl("inline-volume")}>
                <span>Music volume</span>
                <RangeSlider label="Music volume" value={musicVolume} onChange={v => settings.store.musicVolume = v} />
                <span className={cl("volume-value")}>{musicVolume}%</span>
            </label>
        </div>
    );
}

function TrackRow({ track, index, active, playing, editing, setEditing }: {
    track: LibraryItem;
    index: number;
    active: boolean;
    playing: boolean;
    editing: boolean;
    setEditing(editing: boolean): void;
}) {
    const onClick = () => {
        if (editing) return;
        run(() => active ? toggleMusic() : playTrack(track.id));
    };

    return (
        <div
            role="button"
            tabIndex={0}
            className={cl("track", { "track-active": active })}
            onClick={onClick}
            onKeyDown={e => (e.key === "Enter" || e.key === " ") && onClick()}
            onContextMenu={e => openLibraryItemMenu(e, track, () => setEditing(true))}
        >
            <span className={cl("track-index")}>
                {active && playing ? <span className={cl("equalizer")}><i /><i /><i /></span> : index + 1}
            </span>
            {editing ? (
                <RenameInput
                    initialValue={track.name}
                    onDone={name => {
                        setEditing(false);
                        if (name && name !== track.name) void updateItem(track.id, { name });
                    }}
                />
            ) : (
                <span className={cl("track-name")}>{track.name}</span>
            )}
            <span className={cl("track-duration")}>{formatTime(track.duration)}</span>
        </div>
    );
}

export function MusicTab() {
    const { loaded, items: tracks } = useLibrary("music");
    const { currentId, playing } = useStore(musicStore);
    const [query, setQuery] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);

    const visible = tracks.filter(track => matchesQuery(track.name, query));

    return (
        <FileDropZone kind="music">
            <div className={cl("tab")}>
                <NowPlaying tracks={tracks} />
                <div className={cl("toolbar")}>
                    <SearchBox value={query} onChange={setQuery} placeholder="Search your music" />
                    <UploadButton kind="music" label="Add Music" />
                </div>
                <div className={cl("scroller")}>
                    {!loaded ? (
                        <EmptyState icon={<MusicNoteIcon size={32} />} title="Loading your music..." />
                    ) : tracks.length === 0 ? (
                        <EmptyState icon={<MusicNoteIcon size={32} />} title="Your playlist is empty">
                            Click <b>Add Music</b> or drop audio files here. Right-click a track for more options.
                        </EmptyState>
                    ) : visible.length === 0 ? (
                        <EmptyState icon={<MusicNoteIcon size={32} />} title="No tracks match your search" />
                    ) : (
                        <div className={cl("track-list")}>
                            {visible.map(track => (
                                <TrackRow
                                    key={track.id}
                                    track={track}
                                    index={tracks.indexOf(track)}
                                    active={track.id === currentId}
                                    playing={playing}
                                    editing={editingId === track.id}
                                    setEditing={editing => setEditingId(editing ? track.id : null)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </FileDropZone>
    );
}
