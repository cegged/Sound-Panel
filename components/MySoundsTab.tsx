/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { showToast, useState } from "@webpack/common";

import { clipStore, playLibrarySound, stopClip } from "../audio/player";
import { LibraryItem, updateItem, useLibrary } from "../data/library";
import { settings } from "../settings";
import { formatTime, useStore } from "../utils/store";
import { cl, EmptyState, FileDropZone, matchesQuery, RenameInput, SearchBox, UploadButton } from "./common";
import { SpeakerIcon, StopIcon } from "./icons";
import { openLibraryItemMenu } from "./LibraryItemMenu";

const logger = new Logger("SoundPanel");

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

        playLibrarySound(item).catch(err => {
            logger.error("Failed to play sound", err);
            showToast({ text: `Couldn't play "${item.name}"`, variant: "critical" });
        });
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
            <span className={cl("emoji")}><SpeakerIcon size={16} /></span>
            {editing ? (
                <RenameInput
                    initialValue={item.name}
                    onDone={name => {
                        setEditing(false);
                        if (name && name !== item.name) void updateItem(item.id, { name });
                    }}
                />
            ) : (
                <span className={cl("tile-name")}>{item.name}</span>
            )}
            {item.duration > 0 && !editing && <span className={cl("tile-meta")}>{formatTime(item.duration)}</span>}
        </div>
    );
}

export function MySoundsTab() {
    const { loaded, items } = useLibrary("sound");
    const { playing } = useStore(clipStore);
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
                        <EmptyState icon={<SpeakerIcon size={32} />} title="Loading your sounds..." />
                    ) : items.length === 0 ? (
                        <EmptyState icon={<SpeakerIcon size={32} />} title="No sounds yet">
                            Click <b>Add</b> or drop audio files here. Right-click a sound to rename it, change its volume or delete it.
                        </EmptyState>
                    ) : visible.length === 0 ? (
                        <EmptyState icon={<SpeakerIcon size={32} />} title="No sounds match your search" />
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
