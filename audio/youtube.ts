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

// Previews by video id, so pasting a link again doesn't ask YouTube again
const previews = new Map<string, Promise<YouTubePreview>>();

// The video's title, channel and thumbnail, before anything downloads
export function loadYouTubePreview(videoId: string) {
    let preview = previews.get(videoId);
    if (!preview) {
        preview = Native!.getYouTubePreview(`https://www.youtube.com/watch?v=${videoId}`);
        // Asks again next time when YouTube couldn't be reached
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
// The most audio the player gets at once from a saved song. Its buffer holds about 8 MB, and a bigger piece never fits.
const STREAM_CHUNK = 1024 * 1024;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Videos whose download is being started, so pasting a link twice doesn't download it twice
const starting = new Set<string>();
// The downloading song someone asked to hear, and what was playing when they asked
let playRequest: { id: string; currentId: string | null; } | null = null;

// True when the song should play now: it was asked for, and nothing else has started since
function claimPlayRequest(id: string) {
    if (playRequest?.id !== id) return false;

    const stillWanted = musicStore.get().currentId === playRequest.currentId;
    playRequest = null;
    return stillWanted;
}

function streamSong(song: PendingSong) {
    const native = Native!;
    // The whole song, read once its download is done and forgotten
    let saved: Uint8Array<ArrayBuffer> | null | undefined;

    playStream(song.id, song.streamType!, async offset => {
        const state = saved === undefined ? await native.getYouTubeDownload(song.id, offset) : null;
        if (!state) {
            // The rest of the audio is in the library now
            saved ??= await native.readLibraryFile(song.id);
            const bytes = saved?.subarray(offset, offset + STREAM_CHUNK) ?? null;
            return { bytes, done: !saved || offset + (bytes?.length ?? 0) >= saved.length };
        }
        if (state.error) throw new Error(state.error);

        return { bytes: state.bytes, done: !!state.item && offset + (state.bytes?.length ?? 0) >= state.item.size };
    }).catch(err => showError(`Couldn't play "${song.name}"`, err));
}

// Plays a downloading song now if its audio can already stream, otherwise as soon as it can
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
    // The song won't be saved, so it stops now rather than when its audio runs out
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
            // Audio the player can't take while it arrives plays once it's saved
            streamType: state.streamType && MediaSource.isTypeSupported(state.streamType) ? state.streamType : null
        };
        setPendingSong(updated);

        if (updated.streamType && claimPlayRequest(id)) streamSong(updated);

        const { item } = state;
        if (item) {
            // The main process has already saved it to the library
            await refreshLibrary();
            removePendingSong(id);
            void native.finishYouTubeDownload(id);
            showToast({ text: `Added "${item.name}" to Music`, variant: "success" });

            // A song that couldn't stream plays now that it's saved
            if (claimPlayRequest(id)) playTrack(id).catch(err => showError(`Couldn't play "${item.name}"`, err));
            return;
        }
    }
}

export type YouTubeResult = { item: LibraryItem; } | { song: PendingSong; };

// Downloads a link's song in the background, once its card's Download button is pressed. The song shows in
// the playlist right away and plays as soon as its audio starts arriving. A song already in the library
// plays from there instead.
export async function playFromYouTube(link: string): Promise<YouTubeResult> {
    if (!Native) throw new Error("YouTube links need the Discord desktop app");

    const videoId = youTubeVideoId(link);
    if (!videoId) throw new Error("That isn't a link to a YouTube video");

    // Also picks up songs another Discord app added, so a song is never downloaded twice
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
