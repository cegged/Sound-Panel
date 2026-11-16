/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useMemo, useState } from "@webpack/common";

import { logger } from "../utils/logger";
import { Native } from "../utils/native";
import { createStore, useStore } from "../utils/store";
import { youTubeVideoId } from "../utils/youtube";
import type { LibraryItem, LibraryKind, LibraryPatch } from "./libraryIndex";
import { migrateLegacyLibrary, storage } from "./storage";

export type { LibraryItem, LibraryKind } from "./libraryIndex";
export type YouTubeStatus = "idle" | "preparing" | "downloading";

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm|weba)$/i;

const libraryStore = createStore({ loaded: false, items: [] as LibraryItem[] });
// Outside the panel, so closing and reopening it keeps showing a download that's still running
const youTubeStore = createStore({ status: "idle" as YouTubeStatus, progress: null as number | null });
const fileUrls = new Map<string, string>();
const coverUrls = new Map<string, string>();
const coverLoads = new Map<string, Promise<string | null>>();
let loadPromise: Promise<void> | undefined;

const setItems = (items: LibraryItem[]) => libraryStore.set({ loaded: true, items });

function loadLibrary() {
    return loadPromise ??= storage.readIndex()
        .then(migrateLegacyLibrary)
        .then(setItems)
        .catch(err => {
            loadPromise = undefined;
            logger.error("Failed to load the library", err);
        });
}

// Also picks up changes made from another Discord app that shares the library
export async function refreshLibrary() {
    if (!libraryStore.get().loaded) return loadLibrary();

    try {
        setItems(await storage.readIndex());
    } catch (err) {
        logger.error("Failed to refresh the library", err);
    }
}

export function getItems(kind: LibraryKind) {
    return libraryStore.get().items.filter(item => item.kind === kind);
}

export function useLibrary(kind: LibraryKind) {
    const loaded = useStore(libraryStore, s => s.loaded);
    const all = useStore(libraryStore, s => s.items);
    const items = useMemo(() => all.filter(item => item.kind === kind), [all, kind]);
    return { loaded, items };
}

function readDuration(blob: Blob) {
    return new Promise<number>(resolve => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio();
        const done = (duration: number) => {
            URL.revokeObjectURL(url);
            resolve(Number.isFinite(duration) ? duration : 0);
        };

        audio.preload = "metadata";
        audio.onloadedmetadata = () => done(audio.duration);
        audio.onerror = () => done(0);
        setTimeout(() => done(0), 5000);
        audio.src = url;
    });
}

export async function addFiles(files: File[], kind: LibraryKind) {
    await loadLibrary();

    const audioFiles = files.filter(file => file.type.startsWith("audio/") || AUDIO_EXTENSIONS.test(file.name));
    const added: LibraryItem[] = [];

    for (const file of audioFiles) {
        const item: LibraryItem = {
            id: crypto.randomUUID(),
            name: file.name.replace(/\.[^.]+$/, "") || "Untitled",
            kind,
            mimeType: file.type,
            size: file.size,
            duration: await readDuration(file),
            volume: 1,
            addedAt: Date.now()
        };

        await storage.writeFile(item.id, file);
        added.push(item);
    }

    if (added.length) setItems(await storage.changeIndex({ type: "add", items: added }));

    return { added: added.length, skipped: files.length - audioFiles.length };
}

export const isYouTubeLink = (text: string) => !!Native && youTubeVideoId(text) !== null;
export const useYouTubeStatus = () => useStore(youTubeStore, s => s.status);
export const useYouTubeProgress = () => useStore(youTubeStore, s => s.progress);

// Errors from the main process arrive as "Error invoking remote method '...': Error: <reason>"
const nativeReason = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, "");

// Resolves with the song and whether it was just added
export async function addFromYouTube(link: string) {
    if (!Native) throw new Error("YouTube links need the Discord desktop app");
    if (youTubeStore.get().status !== "idle") throw new Error("Another YouTube link is still downloading");

    try {
        await loadLibrary();

        // A song that's already in the library isn't downloaded again
        const videoId = youTubeVideoId(link);
        const existing = videoId ? libraryStore.get().items.find(item => item.youtubeId === videoId) : undefined;
        if (existing) return { item: existing, added: false };

        // yt-dlp and its JavaScript runtime are downloaded the first time only
        if (!await Native.hasYouTubeTools()) {
            youTubeStore.set({ status: "preparing" });
            await Native.prepareYouTubeTools();
        }

        youTubeStore.set({ status: "downloading", progress: 0 });
        const poll = setInterval(() => {
            Native!.getYouTubeProgress().then(progress => {
                if (progress !== null && youTubeStore.get().status === "downloading") youTubeStore.set({ progress });
            }, () => { });
        }, 400);

        try {
            const download = await Native.downloadYouTubeAudio(link);
            const item: LibraryItem = { ...download, kind: "music", volume: 1, addedAt: Date.now() };

            setItems(await storage.changeIndex({ type: "add", items: [item] }));
            return { item, added: true };
        } finally {
            clearInterval(poll);
        }
    } catch (err) {
        throw new Error(nativeReason(err), { cause: err });
    } finally {
        youTubeStore.set({ status: "idle", progress: null });
    }
}

function loadCover(id: string) {
    let load = coverLoads.get(id);
    if (load) return load;

    load = (Native?.readLibraryCover(id) ?? Promise.resolve(null))
        .then(data => {
            if (!data) return null;

            const url = URL.createObjectURL(new Blob([data], { type: "image/jpeg" }));
            coverUrls.set(id, url);
            return url;
        })
        .finally(() => coverLoads.delete(id));

    coverLoads.set(id, load);
    return load;
}

// The song's cover as an image URL, or null while it loads and for songs without one
export function useCoverUrl(item: LibraryItem | undefined) {
    const id = item?.cover ? item.id : null;
    const [, setLoaded] = useState(0);

    useEffect(() => {
        if (!id || coverUrls.has(id)) return;

        let mounted = true;
        loadCover(id).then(() => mounted && setLoaded(n => n + 1), err => logger.error("Failed to load a cover", err));
        return () => { mounted = false; };
    }, [id]);

    return id ? coverUrls.get(id) ?? null : null;
}

export function addBlob(blob: Blob, name: string, kind: LibraryKind) {
    const type = blob.type || "audio/ogg";
    const extension = type === "audio/mpeg" ? "mp3" : type.split("/")[1];
    return addFiles([new File([blob], `${name}.${extension}`, { type })], kind);
}

export async function updateItem(id: string, patch: LibraryPatch) {
    setItems(await storage.changeIndex({ type: "update", id, patch }));
}

export async function removeItem(id: string) {
    revokeUrl(fileUrls, id);
    revokeUrl(coverUrls, id);
    setItems(await storage.changeIndex({ type: "remove", id }));
    await storage.deleteFile(id);
}

export async function getFileUrl(id: string) {
    const cached = fileUrls.get(id);
    if (cached) return cached;

    const item = libraryStore.get().items.find(i => i.id === id);
    const blob = await storage.readFile(id, item?.mimeType ?? "");
    if (!blob) throw new Error("The audio file is missing");

    const url = URL.createObjectURL(blob);
    fileUrls.set(id, url);
    return url;
}

function revokeUrl(urls: Map<string, string>, id: string) {
    const url = urls.get(id);
    if (!url) return;

    URL.revokeObjectURL(url);
    urls.delete(id);
}

export function revokeAllFileUrls() {
    for (const urls of [fileUrls, coverUrls]) {
        urls.forEach(url => URL.revokeObjectURL(url));
        urls.clear();
    }
}
