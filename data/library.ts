/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useMemo } from "@webpack/common";

import { logger } from "../utils/logger";
import { createStore, useStore } from "../utils/store";
import type { LibraryItem, LibraryKind, LibraryPatch } from "./libraryIndex";
import { migrateLegacyLibrary, storage } from "./storage";

export type { LibraryItem, LibraryKind } from "./libraryIndex";

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm|weba)$/i;

const libraryStore = createStore({ loaded: false, items: [] as LibraryItem[] });
const fileUrls = new Map<string, string>();
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

export function addBlob(blob: Blob, name: string, kind: LibraryKind) {
    const type = blob.type || "audio/ogg";
    const extension = type === "audio/mpeg" ? "mp3" : type.split("/")[1];
    return addFiles([new File([blob], `${name}.${extension}`, { type })], kind);
}

export async function updateItem(id: string, patch: LibraryPatch) {
    setItems(await storage.changeIndex({ type: "update", id, patch }));
}

export async function removeItem(id: string) {
    revokeFileUrl(id);
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

function revokeFileUrl(id: string) {
    const url = fileUrls.get(id);
    if (!url) return;

    URL.revokeObjectURL(url);
    fileUrls.delete(id);
}

export function revokeAllFileUrls() {
    fileUrls.forEach(url => URL.revokeObjectURL(url));
    fileUrls.clear();
}
