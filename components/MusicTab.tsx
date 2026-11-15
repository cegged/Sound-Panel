/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LinkIcon } from "@components/Icons";
import { showToast, useEffect, useState } from "@webpack/common";
import type { CSSProperties } from "react";

import {
    cycleRepeatMode,
    musicStore,
    playTrack,
    seekMusic,
    skipTrack,
    toggleMusic,
    toggleShuffle
} from "../audio/player";
import { addFromYouTube, isYouTubeLink, LibraryItem, updateItem, useLibrary, useYouTubeStatus, type YouTubeStatus } from "../data/library";
import { settings } from "../settings";
import { showError } from "../utils/logger";
import { Native } from "../utils/native";
import { useStore } from "../utils/store";
import { cl, EmptyState, FileDropZone, formatTime, matchesQuery, RangeSlider, RenameInput, SearchBox, UploadButton } from "./common";
import {
    MusicNoteIcon,
    NextIcon,
    PauseIcon,
    PlayIcon,
    PreviousIcon,
    RepeatIcon,
    RepeatOneIcon,
    ShuffleIcon,
    SpeakerIcon
} from "./icons";
import { openLibraryItemMenu } from "./LibraryItemMenu";

function run(action: () => Promise<unknown>) {
    action().catch(err => showError("Couldn't play this track", err));
}

// The position changes several times a second, so only this part re-renders for it
function SeekBar({ fallbackDuration }: { fallbackDuration: number; }) {
    const position = useStore(musicStore, s => s.position);
    const duration = useStore(musicStore, s => s.duration) || fallbackDuration;

    return (
        <div className={cl("seek")}>
            <span className={cl("time")}>{formatTime(position)}</span>
            <RangeSlider label="Seek" value={Math.min(position, duration)} max={duration || 1} step={0.1} onChange={seekMusic} />
            <span className={cl("time")}>{formatTime(duration)}</span>
        </div>
    );
}

// Gives every track its own accent color
function hueOf(id: string) {
    let hash = 0;
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return hash;
}

function NowPlaying({ tracks }: { tracks: LibraryItem[]; }) {
    const currentId = useStore(musicStore, s => s.currentId);
    const playing = useStore(musicStore, s => s.playing);
    const { repeatMode, shuffle, musicVolume } = settings.use(["repeatMode", "shuffle", "musicVolume"]);
    const current = tracks.find(track => track.id === currentId);

    return (
        <div className={cl("now-playing")} style={current && { "--vc-soundpanel-hue": hueOf(current.id) } as CSSProperties}>
            <div className={cl("now-playing-info")}>
                <div className={cl("now-playing-art", { "now-playing-art-active": playing })}>
                    <MusicNoteIcon size={24} />
                </div>
                <div className={cl("now-playing-text")}>
                    <div className={cl("now-playing-title")}>{current?.name ?? "Nothing playing"}</div>
                    <div className={cl("now-playing-subtitle")}>
                        {current ? `${tracks.indexOf(current) + 1} of ${tracks.length}` : `${tracks.length} track${tracks.length === 1 ? "" : "s"} in your library`}
                    </div>
                </div>
            </div>

            <SeekBar fallbackDuration={current?.duration ?? 0} />

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
                    <PreviousIcon size={20} />
                </button>
                <button
                    type="button"
                    className={cl("play-button")}
                    aria-label={playing ? "Pause" : "Play"}
                    disabled={!tracks.length}
                    onClick={() => run(toggleMusic)}
                >
                    {playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
                </button>
                <button type="button" className={cl("icon-button")} aria-label="Next" title="Next" onClick={() => run(() => skipTrack(1))}>
                    <NextIcon size={20} />
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

            <label className={cl("inline-volume")} title="Music volume">
                <SpeakerIcon size={16} />
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

const YOUTUBE_LABELS: Record<YouTubeStatus, string> = {
    idle: "Add from YouTube",
    preparing: "Getting ready...",
    downloading: "Downloading..."
};

export function MusicTab() {
    const { loaded, items: tracks } = useLibrary("music");
    const currentId = useStore(musicStore, s => s.currentId);
    const playing = useStore(musicStore, s => s.playing);
    const youTubeStatus = useYouTubeStatus();
    const [query, setQuery] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);

    // A pasted link isn't a search, so the whole playlist stays visible
    const pastedLink = isYouTubeLink(query);
    const visible = pastedLink ? tracks : tracks.filter(track => matchesQuery(track.name, query));

    useEffect(() => {
        if (youTubeStatus === "preparing") showToast({ text: "Getting YouTube links ready. This happens once and downloads about 24 MB" });
    }, [youTubeStatus]);

    const addPastedLink = () => {
        const link = query;
        addFromYouTube(link).then(
            track => {
                setQuery(current => current === link ? "" : current);
                showToast({ text: `Added "${track.name}" to Music`, variant: "success" });
                run(() => playTrack(track.id));
            },
            err => showError(`Couldn't add it from YouTube: ${err.message}`, err)
        );
    };

    return (
        <FileDropZone kind="music">
            <div className={cl("tab")}>
                <NowPlaying tracks={tracks} />
                <form
                    className={cl("toolbar")}
                    onSubmit={e => {
                        e.preventDefault();
                        if (pastedLink && youTubeStatus === "idle") addPastedLink();
                    }}
                >
                    <SearchBox value={query} onChange={setQuery} placeholder={Native ? "Search or paste a YouTube link" : "Search your music"} />
                    {pastedLink || youTubeStatus !== "idle" ? (
                        <button type="submit" className={cl("action-button", "primary")} disabled={youTubeStatus !== "idle"}>
                            <LinkIcon width={16} height={16} />
                            <span>{YOUTUBE_LABELS[youTubeStatus]}</span>
                        </button>
                    ) : (
                        <UploadButton kind="music" label="Add Music" />
                    )}
                </form>
                <div className={cl("scroller")}>
                    {!loaded ? (
                        <EmptyState icon={<MusicNoteIcon size={28} />} title="Loading your music..." />
                    ) : tracks.length === 0 ? (
                        <EmptyState icon={<MusicNoteIcon size={28} />} title="Your playlist is empty">
                            Click <b>Add Music</b>, drop audio files here{Native && " or paste a YouTube link above"}. Right-click a track for more options.
                        </EmptyState>
                    ) : visible.length === 0 ? (
                        <EmptyState icon={<MusicNoteIcon size={28} />} title="No tracks match your search" />
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
