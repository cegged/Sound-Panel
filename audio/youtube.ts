/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showToast } from "@webpack/common";

import {
    findLibrarySong,
    findPendingSong,
    getPendingSong,
    type LibraryItem,
    nativeReason,
    type PendingSong,
    prepareYouTube,
    refreshLibrary,
    removePendingSong,
    setPendingSong
} from "../data/library";
import { showError } from "../utils/logger";
import { Native } from "../utils/native";
import { youTubeVideoId } from "../utils/youtube";
import { musicStore, playStream, playTrack, releaseTrack } from "./player";

export type YouTubePreview = Awaited<ReturnType<NonNullable<typeof Native>["getYouTubePreview"]>>;

const previews = new Map<string, Promise<YouTubePreview>>();

export function loadYouTubePreview(videoId: string) {
    let preview = previews.get(videoId);
    if (!preview) {
        preview = Native!.getYouTubePreview(`https://www.youtube.com/watch?v=${videoId}`);
        preview.then(
            ({ video }) => {
                if (!video.found && video.reason === "unreachable") previews.delete(videoId);
            },
            () => previews.delete(videoId)
        );
        previews.set(videoId, preview);
    }
    return preview;
}

const POLL_INTERVAL = 400;
const STREAM_CHUNK = 1024 * 1024;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const starting = new Set<string>();
let playRequest: { id: string; currentId: string | null; } | null = null;

function claimPlayRequest(id: string) {
    if (playRequest?.id !== id) return false;

    const stillWanted = musicStore.get().currentId === playRequest.currentId;
    playRequest = null;
    return stillWanted;
}

function streamSong(song: PendingSong) {
    const native = Native!;
    let saved: Uint8Array<ArrayBuffer> | null | undefined;

    playStream(song.id, song.streamType!, async offset => {
        const state = saved === undefined ? await native.getYouTubeDownload(song.id, offset) : null;
        if (!state) {
            saved ??= await native.readLibraryFile(song.id);
            const bytes = saved?.subarray(offset, offset + STREAM_CHUNK) ?? null;
            return { bytes, done: !saved || offset + (bytes?.length ?? 0) >= saved.length };
        }
        if (state.error) throw new Error(state.error);

        return { bytes: state.bytes, done: !!state.item && offset + (state.bytes?.length ?? 0) >= state.item.size };
    }).catch(err => showError(`Couldn't play "${song.name}"`, err));
}

export function playPendingSong(id: string) {
    const song = getPendingSong(id);
    if (!song) return;

    if (song.streamType) {
        playRequest = null;
        streamSong(song);
    } else {
        playRequest = { id, currentId: musicStore.get().currentId };
    }
}

function giveUp(id: string, reason: string) {
    if (playRequest?.id === id) playRequest = null;
    releaseTrack(id);
    removePendingSong(id);
    void Native!.finishYouTubeDownload(id);
    showError(`Couldn't add it from YouTube: ${reason}`, new Error(reason));
}

async function followDownload(id: string) {
    const native = Native!;

    for (;;) {
        await sleep(POLL_INTERVAL);

        let state: Awaited<ReturnType<typeof native.getYouTubeDownload>>;
        try {
            state = await native.getYouTubeDownload(id, -1);
        } catch (err) {
            return giveUp(id, nativeReason(err));
        }
        if (!state) return giveUp(id, "The download stopped");
        if (state.error) return giveUp(id, state.error);

        const song = getPendingSong(id);
        if (!song) return;

        const updated: PendingSong = {
            ...song,
            name: state.title || song.name,
            artist: state.channel || song.artist,
            cover: state.cover,
            duration: state.duration || song.duration,
            progress: state.progress,
            streamType: state.streamType && MediaSource.isTypeSupported(state.streamType) ? state.streamType : null
        };
        setPendingSong(updated);

        if (updated.streamType && claimPlayRequest(id)) streamSong(updated);

        const { item } = state;
        if (item) {
            await refreshLibrary();
            removePendingSong(id);
            void native.finishYouTubeDownload(id);
            showToast({ text: `Added "${item.name}" to Music`, variant: "success" });

            if (claimPlayRequest(id)) playTrack(id).catch(err => showError(`Couldn't play "${item.name}"`, err));
            return;
        }
    }
}

export type YouTubeResult = { item: LibraryItem; } | { song: PendingSong; };

export async function playFromYouTube(link: string): Promise<YouTubeResult> {
    if (!Native) throw new Error("YouTube links need the Discord desktop app");

    const videoId = youTubeVideoId(link);
    if (!videoId) throw new Error("That isn't a link to a YouTube video");

    await refreshLibrary();
    const item = findLibrarySong(videoId);
    if (item) return { item };

    const pending = findPendingSong(videoId);
    if (pending) {
        playPendingSong(pending.id);
        return { song: pending };
    }
    if (starting.has(videoId)) throw new Error("That link is already on its way");

    starting.add(videoId);
    try {
        await prepareYouTube();
        const id = await Native.startYouTubeDownload(link);

        const song: PendingSong = {
            id,
            youtubeId: videoId,
            name: "Loading from YouTube...",
            cover: false,
            duration: 0,
            progress: null,
            streamType: null
        };
        setPendingSong(song);
        playPendingSong(id);
        void followDownload(id);

        return { song };
    } catch (err) {
        throw new Error(nativeReason(err), { cause: err });
    } finally {
        starting.delete(videoId);
    }
}
