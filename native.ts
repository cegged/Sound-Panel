/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { desktopCapturer, IpcMainInvokeEvent, Session } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";

import { applyIndexChange, type IndexChange, type LibraryItem } from "./data/libraryIndex";

export interface ScreenSource {
    id: string;
    name: string;
    thumbnail: string;
    icon: string | null;
}

// In Vencord's data folder, so Stable, PTB and Canary share one library
const LIBRARY_DIR = join(DATA_DIR, "SoundPanel");
const FILES_DIR = join(LIBRARY_DIR, "files");
const INDEX_FILE = join(LIBRARY_DIR, "library.json");

const SOUNDBOARD_URL = /^https:\/\/cdn\.discordapp\.com\/soundboard-sounds\/\d+$/;
const CAPTURE_TYPES: ("screen" | "window")[] = ["screen", "window"];

let indexQueue: Promise<unknown> = Promise.resolve();
let pendingSource: { id: string; audio: boolean; } | null = null;
const sessionsWithHandler = new WeakSet<Session>();

function libraryFilePath(id: string) {
    // Ids are UUIDs; anything else could point outside the library folder
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid library file id");
    return join(FILES_DIR, id);
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

async function readIndexFile(): Promise<LibraryItem[]> {
    try {
        const items = JSON.parse(await readFile(INDEX_FILE, "utf8"));
        return Array.isArray(items) ? items : [];
    } catch (err) {
        if (isMissing(err)) return [];
        throw err;
    }
}

export function readLibraryIndex(_: IpcMainInvokeEvent) {
    return readIndexFile();
}

// One change at a time, written through a temp file so the index is never left half written
export function changeLibraryIndex(_: IpcMainInvokeEvent, change: IndexChange) {
    const task = indexQueue.then(async () => {
        const items = applyIndexChange(await readIndexFile(), change);

        await mkdir(LIBRARY_DIR, { recursive: true });
        await writeFile(`${INDEX_FILE}.tmp`, JSON.stringify(items));
        await rename(`${INDEX_FILE}.tmp`, INDEX_FILE);

        return items;
    });

    indexQueue = task.catch(() => { });
    return task;
}

export async function writeLibraryFile(_: IpcMainInvokeEvent, id: string, data: Uint8Array) {
    await mkdir(FILES_DIR, { recursive: true });
    await writeFile(libraryFilePath(id), data);
}

export async function readLibraryFile(_: IpcMainInvokeEvent, id: string) {
    try {
        return new Uint8Array(await readFile(libraryFilePath(id)));
    } catch (err) {
        if (isMissing(err)) return null;
        throw err;
    }
}

export async function deleteLibraryFile(_: IpcMainInvokeEvent, id: string) {
    await rm(libraryFilePath(id), { force: true });
}

// Discord's CDN sends broken CORS headers to PTB and Canary, which doesn't matter out here
export async function downloadSoundboardSound(_: IpcMainInvokeEvent, url: string) {
    if (!SOUNDBOARD_URL.test(url)) throw new Error("Only Discord soundboard sounds can be downloaded");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed with status ${res.status}`);

    return {
        type: res.headers.get("content-type") ?? "audio/ogg",
        data: new Uint8Array(await res.arrayBuffer())
    };
}

export async function getScreenSources(_: IpcMainInvokeEvent): Promise<ScreenSource[]> {
    const sources = await desktopCapturer.getSources({
        types: CAPTURE_TYPES,
        thumbnailSize: { width: 384, height: 216 },
        fetchWindowIcons: true
    });

    return sources.map(source => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
        icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
    }));
}

// Electron only allows getDisplayMedia through a request handler, which gets the source picked for this call
export function selectScreenSource(event: IpcMainInvokeEvent, id: string, audio: boolean) {
    pendingSource = { id, audio };

    const { session } = event.sender;
    if (sessionsWithHandler.has(session)) return;
    sessionsWithHandler.add(session);

    session.setDisplayMediaRequestHandler((request, callback) => {
        const choice = pendingSource;
        pendingSource = null;

        // Denying makes getDisplayMedia reject like a cancelled browser prompt
        if (!choice) return callback({});

        desktopCapturer.getSources({ types: CAPTURE_TYPES })
            .then(sources => {
                const source = sources.find(s => s.id === choice.id);
                if (!source) return callback({});

                callback({ video: source, audio: choice.audio && request.audioRequested ? "loopback" : undefined });
            })
            .catch(() => callback({}));
    });
}
