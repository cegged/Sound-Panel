/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { debounce } from "@shared/debounce";
import { Logger } from "@utils/Logger";
import { ContextMenuApi, Menu, showToast } from "@webpack/common";

import { applyMusicVolume, playLibrarySound, playTrack, releaseTrack, stopClip } from "../audio/player";
import { LibraryItem, removeItem, updateItem } from "../data/library";
import { DeleteIcon, EditIcon, HeadphonesIcon, MusicNoteIcon, PlayIcon, SpeakerIcon } from "./icons";

const logger = new Logger("SoundPanel");

function reportError(action: string) {
    return (err: unknown) => {
        logger.error(`Failed to ${action}`, err);
        showToast({ text: `Couldn't ${action}`, variant: "critical" });
    };
}

const setVolume = debounce((item: LibraryItem, volume: number) => {
    updateItem(item.id, { volume: volume / 100 })
        .then(() => item.kind === "music" && applyMusicVolume())
        .catch(reportError("change the volume"));
}, 150);

function LibraryItemMenu({ item, onRename }: { item: LibraryItem; onRename(): void; }) {
    const isSound = item.kind === "sound";
    const moveTarget = isSound ? "music" : "sound";

    const release = () => {
        stopClip(item.id);
        releaseTrack(item.id);
    };

    return (
        <Menu.Menu navId="vc-soundpanel-item" onClose={ContextMenuApi.closeContextMenu} aria-label={item.name}>
            <Menu.MenuItem
                id="vc-soundpanel-play"
                label={isSound ? "Play" : "Play Track"}
                icon={PlayIcon}
                action={() => (isSound ? playLibrarySound(item) : playTrack(item.id)).catch(reportError("play the file"))}
            />
            {isSound && (
                <Menu.MenuItem
                    id="vc-soundpanel-preview"
                    label="Play Only For Me"
                    icon={HeadphonesIcon}
                    action={() => playLibrarySound(item, true).catch(reportError("play the file"))}
                />
            )}
            <Menu.MenuSeparator />
            <Menu.MenuControlItem
                id="vc-soundpanel-volume"
                label="Volume"
                control={(props, ref) => (
                    <Menu.MenuSliderControl
                        {...props}
                        ref={ref}
                        minValue={0}
                        maxValue={200}
                        value={Math.round(item.volume * 100)}
                        onChange={(value: number) => setVolume(item, value)}
                        renderValue={(value: number) => `${Math.round(value)}%`}
                    />
                )}
            />
            <Menu.MenuItem
                id="vc-soundpanel-rename"
                label="Rename"
                icon={EditIcon}
                action={onRename}
            />
            <Menu.MenuItem
                id="vc-soundpanel-move"
                label={isSound ? "Move to Music" : "Move to My Sounds"}
                icon={isSound ? MusicNoteIcon : SpeakerIcon}
                action={() => {
                    release();
                    updateItem(item.id, { kind: moveTarget }).catch(reportError("move the file"));
                }}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-soundpanel-delete"
                label="Delete"
                color="danger"
                icon={DeleteIcon}
                action={() => {
                    release();
                    removeItem(item.id).catch(reportError("delete the file"));
                }}
            />
        </Menu.Menu>
    );
}

export function openLibraryItemMenu(event: React.MouseEvent, item: LibraryItem, onRename: () => void) {
    ContextMenuApi.openContextMenu(event, () => <LibraryItemMenu item={item} onRename={onRename} />);
}
