/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createStore as createIdbStore, del, get, set, type UseStore } from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { createStore, useStore } from "../utils/store";

export type LibraryKind = "sound" | "music";

export interface LibraryItem {
    id: string;
    name: string;
    kind: LibraryKind;
    mimeType: string;
    size: number;
    duration: number;
    volume: number;
    addedAt: number;
}

const logger = new Logger("SoundPanel");

const INDEX_KEY = "index";
const fileKey = (id: string) => `file:${id}`;
const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm|weba)$/i;

let idbStore: UseStore | undefined;
// Opened lazily so a disabled plugin never touches IndexedDB
const db = () => idbStore ??= createIdbStore("SoundPanelData", "SoundPanelStore");

export const libraryStore = createStore({ loaded: false, items: [] as LibraryItem[] });

const fileUrls = new Map<string, string>();
let loadPromise: Promise<void> | undefined;

export function loadLibrary() {
    return loadPromise ??= get<LibraryItem[]>(INDEX_KEY, db())
        .then(items => libraryStore.set({ loaded: true, items: items ?? [] }))
        .catch(err => {
            loadPromise = undefined;
            logger.error("Failed to load library", err);
        });
}

async function saveItems(items: LibraryItem[]) {
    libraryStore.set({ items });
    await set(INDEX_KEY, items, db());
}

export function getItems(kind: LibraryKind) {
    return libraryStore.get().items.filter(item => item.kind === kind);
}

export function useLibrary(kind: LibraryKind) {
    const { loaded, items } = useStore(libraryStore);
    return { loaded, items: items.filter(item => item.kind === kind) };
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || AUDIO_EXTENSIONS.test(file.name);
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

const stripExtension = (name: string) => name.replace(/\.[^.]+$/, "");

export async function addFiles(files: File[], kind: LibraryKind) {
    await loadLibrary();

    const audioFiles = files.filter(isAudioFile);
    const added: LibraryItem[] = [];

    for (const file of audioFiles) {
        const item: LibraryItem = {
            id: crypto.randomUUID(),
            name: stripExtension(file.name) || "Untitled",
            kind,
            mimeType: file.type,
            size: file.size,
            duration: await readDuration(file),
            volume: 1,
            addedAt: Date.now()
        };

        await set(fileKey(item.id), file, db());
        added.push(item);
    }

    if (added.length) await saveItems([...libraryStore.get().items, ...added]);

    return { added: added.length, skipped: files.length - audioFiles.length };
}

export async function addBlob(blob: Blob, name: string, kind: LibraryKind) {
    const type = blob.type || "audio/ogg";
    const extension = type === "audio/mpeg" ? "mp3" : type.split("/")[1];
    return addFiles([new File([blob], `${name}.${extension}`, { type })], kind);
}

export async function updateItem(id: string, patch: Partial<Pick<LibraryItem, "name" | "volume" | "kind">>) {
    await saveItems(libraryStore.get().items.map(item => item.id === id ? { ...item, ...patch } : item));
}

export async function removeItem(id: string) {
    revokeFileUrl(id);
    await saveItems(libraryStore.get().items.filter(item => item.id !== id));
    await del(fileKey(id), db());
}

export async function getFileUrl(id: string) {
    const cached = fileUrls.get(id);
    if (cached) return cached;

    const blob = await get<Blob>(fileKey(id), db());
    if (!blob) throw new Error("Audio file is missing from storage");

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
    for (const id of [...fileUrls.keys()]) revokeFileUrl(id);
}
