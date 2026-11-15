/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { clipStore, playLibrarySound, stopClip } from "../audio/player";
import { LibraryItem, updateItem, useLibrary } from "../data/library";
import { settings } from "../settings";
import { showError } from "../utils/logger";
import { useStore } from "../utils/store";
import { cl, EmptyState, FileDropZone, formatTime, matchesQuery, RenameInput, SearchBox, UploadButton } from "./common";
import { StopIcon, WaveformIcon } from "./icons";
import { openLibraryItemMenu } from "./LibraryItemMenu";

// Sound effects are short, so "0.8s" says more than "0:00"
const clipLength = (seconds: number) => seconds < 60 ? `${seconds.toFixed(1)}s` : formatTime(seconds);

function SoundTile({ item, playing, editing, setEditing }: {
    item: LibraryItem;
    playing: boolean;
    editing: boolean;
    setEditing(editing: boolean): void;
}) {
    const onClick = () => {
        if (editing) return;

        // With overlap on, every click starts another instance; otherwise a click on a playing sound stops it
        if (playing && !settings.store.allowOverlap) {
            stopClip(item.id);
            return;
        }

        playLibrarySound(item).catch(err => showError(`Couldn't play "${item.name}"`, err));
    };

    return (
        <div
            role="button"
            tabIndex={0}
            title={item.name}
            className={cl("tile", { "tile-playing": playing })}
            onClick={onClick}
            onKeyDown={e => (e.key === "Enter" || e.key === " ") && onClick()}
            onContextMenu={e => openLibraryItemMenu(e, item, () => setEditing(true))}
        >
            <span className={cl("tile-icon")}><WaveformIcon size={16} /></span>
            {editing ? (
                <RenameInput
                    initialValue={item.name}
                    onDone={name => {
                        setEditing(false);
                        if (name && name !== item.name) void updateItem(item.id, { name });
                    }}
                />
            ) : (
                <span className={cl("tile-text")}>
                    <span className={cl("tile-name")}>{item.name}</span>
                    {item.duration > 0 && <span className={cl("tile-meta")}>{clipLength(item.duration)}</span>}
                </span>
            )}
        </div>
    );
}

export function MySoundsTab() {
    const { loaded, items } = useLibrary("sound");
    const playing = useStore(clipStore, s => s.playing);
    const [query, setQuery] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);

    const visible = items.filter(item => matchesQuery(item.name, query));
    const anyPlaying = items.some(item => playing.includes(item.id));

    return (
        <FileDropZone kind="sound">
            <div className={cl("tab")}>
                <div className={cl("toolbar")}>
                    <SearchBox value={query} onChange={setQuery} placeholder="Search your sounds" />
                    {anyPlaying && (
                        <button
                            type="button"
                            className={cl("icon-button")}
                            aria-label="Stop your sounds"
                            title="Stop your sounds"
                            onClick={() => items.forEach(item => stopClip(item.id))}
                        >
                            <StopIcon size={18} />
                        </button>
                    )}
                    <UploadButton kind="sound" label="Add" />
                </div>
                <div className={cl("scroller")}>
                    {!loaded ? (
                        <EmptyState icon={<WaveformIcon size={28} />} title="Loading your sounds..." />
                    ) : items.length === 0 ? (
                        <EmptyState icon={<WaveformIcon size={28} />} title="No sounds yet">
                            Click <b>Add</b> or drop audio files here. Right-click a sound to rename it, change its volume or delete it.
                        </EmptyState>
                    ) : visible.length === 0 ? (
                        <EmptyState icon={<WaveformIcon size={28} />} title="No sounds match your search" />
                    ) : (
                        <div className={cl("grid")}>
                            {visible.map(item => (
                                <SoundTile
                                    key={item.id}
                                    item={item}
                                    playing={playing.includes(item.id)}
                                    editing={editingId === item.id}
                                    setEditing={editing => setEditingId(editing ? item.id : null)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </FileDropZone>
    );
}
