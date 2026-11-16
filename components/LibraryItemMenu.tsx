/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DeleteIcon, OpenExternalIcon, PencilIcon } from "@components/Icons";
import { debounce } from "@shared/debounce";
import { ContextMenuApi, Menu } from "@webpack/common";

import { isLibraryJoinSound, setJoinSound } from "../audio/joinSound";
import { applyMusicVolume, playLibrarySound, playTrack, releaseTrack, stopClip } from "../audio/player";
import { LibraryItem, removeItem, updateItem } from "../data/library";
import { settings } from "../settings";
import { showError } from "../utils/logger";
import { useGlassMenu } from "./common";
import { HeadphonesIcon, JoinSoundIcon, MusicNoteIcon, PlayIcon, StarIcon, WaveformIcon } from "./icons";

const setVolume = debounce((item: LibraryItem, volume: number) => {
    updateItem(item.id, { volume: volume / 100 })
        .then(() => item.kind === "music" && applyMusicVolume())
        .catch(err => showError("Couldn't change the volume", err));
}, 150);

function LibraryItemMenu({ item, onRename }: { item: LibraryItem; onRename(): void; }) {
    const { joinSound } = settings.use(["joinSound"]);
    const glass = useGlassMenu();
    const isSound = item.kind === "sound";
    // A join sound moved to Music can still be removed from here
    const isJoinSound = isLibraryJoinSound(joinSound, item.id);
    const moveTarget = isSound ? "music" : "sound";

    const play = (localOnly?: boolean) => (isSound ? playLibrarySound(item, localOnly) : playTrack(item.id))
        .catch(err => showError(`Couldn't play "${item.name}"`, err));

    const release = () => {
        stopClip(item.id);
        releaseTrack(item.id);
    };

    return (
        <Menu.Menu navId="vc-soundpanel-item" onClose={ContextMenuApi.closeContextMenu} aria-label={item.name} {...glass}>
            <Menu.MenuItem
                id="vc-soundpanel-play"
                label={isSound ? "Play" : "Play Track"}
                icon={PlayIcon}
                action={() => play()}
            />
            {isSound && (
                <Menu.MenuItem
                    id="vc-soundpanel-preview"
                    label="Play Only For Me"
                    icon={HeadphonesIcon}
                    action={() => play(true)}
                />
            )}
            {item.youtubeId && (
                <Menu.MenuItem
                    id="vc-soundpanel-open-youtube"
                    label="Open on YouTube"
                    icon={OpenExternalIcon}
                    action={() => VencordNative.native.openExternal(`https://www.youtube.com/watch?v=${item.youtubeId}`)}
                />
            )}
            {(isSound || isJoinSound) && <Menu.MenuSeparator />}
            {isSound && (
                <Menu.MenuItem
                    id="vc-soundpanel-favorite"
                    label={item.favorite ? "Remove from Favorites" : "Add to Favorites"}
                    icon={StarIcon}
                    action={() => updateItem(item.id, { favorite: !item.favorite }).catch(err => showError(`Couldn't change "${item.name}"`, err))}
                />
            )}
            {(isSound || isJoinSound) && (
                <Menu.MenuItem
                    id="vc-soundpanel-join-sound"
                    label={isJoinSound ? "Remove Join Sound" : "Set as Join Sound"}
                    icon={JoinSoundIcon}
                    action={() => setJoinSound(isJoinSound ? null : { type: "library", id: item.id }, item.name)}
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
                icon={PencilIcon}
                action={onRename}
            />
            <Menu.MenuItem
                id="vc-soundpanel-move"
                label={isSound ? "Move to Music" : "Move to My Sounds"}
                icon={isSound ? MusicNoteIcon : WaveformIcon}
                action={() => {
                    release();
                    updateItem(item.id, { kind: moveTarget }).catch(err => showError(`Couldn't move "${item.name}"`, err));
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
                    // Nothing would be left to play when you join a channel
                    if (isJoinSound) settings.store.joinSound = null;
                    removeItem(item.id).catch(err => showError(`Couldn't delete "${item.name}"`, err));
                }}
            />
        </Menu.Menu>
    );
}

export function openLibraryItemMenu(event: React.MouseEvent, item: LibraryItem, onRename: () => void) {
    ContextMenuApi.openContextMenu(event, () => <LibraryItemMenu item={item} onRename={onRename} />);
}
