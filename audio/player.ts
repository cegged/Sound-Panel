/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getFileUrl, getItems, LibraryItem } from "../data/library";
import { RepeatMode, settings } from "../settings";
import { logger } from "../utils/logger";
import { createStore, useStore } from "../utils/store";
import { connectToOutputs, getAudioContext, routeToOutputDevice, setPlaybackActive } from "./mixer";

interface Clip {
    key: string;
    localOnly: boolean;
    dispose(): void;
}

const clips = new Set<Clip>();

export const clipStore = createStore({ playing: [] as string[] });

export const musicStore = createStore({
    currentId: null as string | null,
    playing: false,
    position: 0,
    duration: 0
});

let musicAudio: HTMLAudioElement | null = null;
let musicSource: MediaElementAudioSourceNode | null = null;
let musicGain: GainNode | null = null;
// A track playing while its audio still arrives, like a YouTube song that's downloading
let stream: { id: string; stopped: boolean; } | null = null;

// Hands over a track's audio from offset onwards; done once nothing more will come after these bytes
type ReadAudio = (offset: number) => Promise<{ bytes: Uint8Array<ArrayBuffer> | null; done: boolean; }>;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function updatePlaybackActive() {
    setPlaybackActive([...clips].some(clip => !clip.localOnly) || musicStore.get().playing);
}

function syncClips() {
    clipStore.set({ playing: [...clips].map(clip => clip.key) });
    updatePlaybackActive();
}

function routeThroughMixer(audio: HTMLAudioElement, volume: number) {
    const ctx = getAudioContext();
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    connectToOutputs(gain);

    return () => {
        source.disconnect();
        gain.disconnect();
    };
}

// Skips the audio graph, which would need CORS headers that Discord's CDN doesn't send to PTB and Canary
function playDirectly(audio: HTMLAudioElement, volume: number) {
    audio.volume = Math.min(1, volume * (settings.store.localVolume / 100));
    void routeToOutputDevice(audio);
    return () => { };
}

export async function playClip({ key, url, volume, localOnly = false }: { key: string; url: string; volume: number; localOnly?: boolean; }) {
    if (!settings.store.allowOverlap) stopClips();

    const audio = new Audio(url);
    const disconnect = localOnly ? playDirectly(audio, volume) : routeThroughMixer(audio, volume);

    const clip: Clip = {
        key,
        localOnly,
        dispose() {
            if (!clips.delete(clip)) return;

            audio.pause();
            audio.removeAttribute("src");
            audio.load();
            disconnect();
            syncClips();
        }
    };

    audio.addEventListener("ended", clip.dispose);
    audio.addEventListener("error", () => {
        logger.error(`Failed to load audio for ${key}`, audio.error);
        clip.dispose();
    });
    clips.add(clip);
    syncClips();

    try {
        await audio.play();
    } catch (err) {
        clip.dispose();
        throw err;
    }
}

export async function playLibrarySound(item: LibraryItem, localOnly = false) {
    await playClip({ key: item.id, url: await getFileUrl(item.id), volume: item.volume, localOnly });
}

export function stopClip(key: string) {
    [...clips].filter(clip => clip.key === key).forEach(clip => clip.dispose());
}

function stopClips() {
    [...clips].forEach(clip => clip.dispose());
}

function getMusicElement() {
    if (musicAudio) return musicAudio;

    const ctx = getAudioContext();
    const audio = musicAudio = new Audio();
    musicSource = ctx.createMediaElementSource(audio);
    musicGain = ctx.createGain();
    musicSource.connect(musicGain);
    connectToOutputs(musicGain);
    applyMusicVolume();

    const setPlaying = (playing: boolean) => {
        musicStore.set({ playing });
        updatePlaybackActive();
    };

    audio.addEventListener("timeupdate", () => musicStore.set({ position: audio.currentTime }));
    audio.addEventListener("durationchange", () => musicStore.set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }));
    audio.addEventListener("play", () => setPlaying(true));
    audio.addEventListener("pause", () => setPlaying(false));
    audio.addEventListener("ended", onTrackEnded);

    return audio;
}

function getCurrentTrack() {
    const { currentId } = musicStore.get();
    return getItems("music").find(item => item.id === currentId);
}

export function applyMusicVolume() {
    if (musicGain) musicGain.gain.value = (settings.store.musicVolume / 100) * (getCurrentTrack()?.volume ?? 1);
}

export async function playTrack(id: string) {
    const audio = getMusicElement();
    // A song playing while it downloads keeps going if this track can't be read
    const url = await getFileUrl(id);
    stopStream();
    audio.src = url;
    musicStore.set({ currentId: id, position: 0, duration: 0 });
    applyMusicVolume();
    await audio.play();
}

function stopStream() {
    if (stream) stream.stopped = true;
    stream = null;
}

function whenUpdated(buffer: SourceBuffer) {
    return new Promise<void>((resolve, reject) => {
        const done = () => {
            buffer.removeEventListener("error", failed);
            resolve();
        };
        const failed = () => {
            buffer.removeEventListener("updateend", done);
            reject(new Error("The audio couldn't be decoded"));
        };
        buffer.addEventListener("updateend", done, { once: true });
        buffer.addEventListener("error", failed, { once: true });
    });
}

// A full buffer drops what has already played, or waits for playback to catch up with the download.
// It holds about 8 MB, ten minutes of a YouTube song.
async function appendAudio(session: { stopped: boolean; }, audio: HTMLAudioElement, buffer: SourceBuffer, bytes: Uint8Array<ArrayBuffer>) {
    while (!session.stopped) {
        try {
            buffer.appendBuffer(bytes);
            return await whenUpdated(buffer);
        } catch (err) {
            if ((err as DOMException)?.name !== "QuotaExceededError") throw err;

            const playedUntil = audio.currentTime - 10;
            if (buffer.buffered.length && buffer.buffered.start(0) < playedUntil) {
                buffer.remove(0, playedUntil);
                await whenUpdated(buffer);
            } else {
                await sleep(1000);
            }
        }
    }
}

async function feedStream(session: { stopped: boolean; }, audio: HTMLAudioElement, source: MediaSource, buffer: SourceBuffer, read: ReadAudio) {
    let offset = 0;

    while (!session.stopped && source.readyState === "open") {
        const { bytes, done } = await read(offset);
        if (session.stopped || source.readyState !== "open") return;

        if (bytes?.length) {
            await appendAudio(session, audio, buffer, bytes);
            offset += bytes.length;
        }
        if (done) {
            if (source.readyState === "open" && !buffer.updating) source.endOfStream();
            return;
        }
        if (!bytes?.length) await sleep(250);
    }
}

// Plays a track while its audio still arrives, through a MediaSource that read() keeps filling.
// The call hears it like any other track.
export async function playStream(id: string, type: string, read: ReadAudio) {
    const audio = getMusicElement();
    stopStream();
    const session = stream = { id, stopped: false };

    const source = new MediaSource();
    const url = URL.createObjectURL(source);
    audio.src = url;
    musicStore.set({ currentId: id, position: 0, duration: 0 });
    applyMusicVolume();

    await new Promise(resolve => source.addEventListener("sourceopen", resolve, { once: true }));
    URL.revokeObjectURL(url);
    if (session.stopped) return;

    const buffer = source.addSourceBuffer(type);
    feedStream(session, audio, source, buffer, read).catch(err => logger.error(`Failed to stream ${id}`, err));

    // Starting another track before this one has sound isn't a failure
    await audio.play().catch(err => {
        if ((err as DOMException)?.name !== "AbortError") throw err;
    });
}

export async function toggleMusic() {
    const audio = getMusicElement();
    const { currentId } = musicStore.get();
    const hasTrack = currentId !== null && (stream?.id === currentId || getCurrentTrack() !== undefined);

    if (!hasTrack) {
        const [first] = getItems("music");
        if (first) await playTrack(first.id);
    } else if (audio.paused) {
        await audio.play();
    } else {
        audio.pause();
    }
}

export async function skipTrack(direction: 1 | -1, automatic = false) {
    const tracks = getItems("music");
    if (!tracks.length) return;

    // Like most players, "previous" restarts the track unless it just started
    if (direction === -1 && musicAudio && musicAudio.currentTime > 3) {
        musicAudio.currentTime = 0;
        return;
    }

    const index = tracks.findIndex(track => track.id === musicStore.get().currentId);
    let next: number;

    if (settings.store.shuffle && tracks.length > 1) {
        do next = Math.floor(Math.random() * tracks.length);
        while (next === index);
    } else if (index === -1) {
        // Nothing from the playlist plays, or a song still downloading, which sits above the playlist
        next = direction === 1 ? 0 : tracks.length - 1;
    } else {
        next = index + direction;

        if (next < 0 || next >= tracks.length) {
            if (automatic && settings.store.repeatMode === "off") {
                stopMusic();
                return;
            }
            next = (next + tracks.length) % tracks.length;
        }
    }

    await playTrack(tracks[next].id);
}

function onTrackEnded() {
    if (settings.store.repeatMode === "one" && musicAudio) {
        musicAudio.currentTime = 0;
        musicAudio.play().catch(err => logger.error("Failed to repeat the track", err));
        return;
    }

    skipTrack(1, true).catch(err => logger.error("Failed to play the next track", err));
}

export function seekMusic(seconds: number) {
    if (!musicAudio || !Number.isFinite(seconds)) return;

    musicAudio.currentTime = seconds;
    musicStore.set({ position: seconds });
}

function stopMusic() {
    if (!musicAudio) return;

    musicAudio.pause();
    musicAudio.currentTime = 0;
    musicStore.set({ position: 0 });
}

// Unloads the track before it's deleted or moved out of the playlist
export function releaseTrack(id: string) {
    if (!musicAudio || musicStore.get().currentId !== id) return;

    if (stream?.id === id) stopStream();
    musicAudio.pause();
    musicAudio.removeAttribute("src");
    musicAudio.load();
    musicStore.set({ currentId: null, playing: false, position: 0, duration: 0 });
}

const REPEAT_ORDER: RepeatMode[] = ["all", "one", "off"];

export function cycleRepeatMode() {
    const current = REPEAT_ORDER.indexOf(settings.store.repeatMode as RepeatMode);
    settings.store.repeatMode = REPEAT_ORDER[(current + 1) % REPEAT_ORDER.length];
}

export function toggleShuffle() {
    settings.store.shuffle = !settings.store.shuffle;
}

export function stopAll() {
    stopClips();
    musicAudio?.pause();
}

export function disposePlayer() {
    stopClips();
    stopStream();

    if (musicAudio) {
        musicAudio.pause();
        musicAudio.removeAttribute("src");
        musicAudio.load();
    }
    musicSource?.disconnect();
    musicGain?.disconnect();
    musicAudio = musicSource = musicGain = null;

    musicStore.set({ currentId: null, playing: false, position: 0, duration: 0 });
    setPlaybackActive(false);
}

export function useIsPlaying() {
    const clipsPlaying = useStore(clipStore, s => s.playing.length > 0);
    const musicPlaying = useStore(musicStore, s => s.playing);
    return clipsPlaying || musicPlaying;
}
