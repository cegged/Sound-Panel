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

// ---------- Sound library ----------
// Kept in Vencord's data folder, so Discord Stable, PTB and Canary all share one library

const LIBRARY_DIR = join(DATA_DIR, "SoundPanel");
const FILES_DIR = join(LIBRARY_DIR, "files");
const INDEX_FILE = join(LIBRARY_DIR, "library.json");
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function libraryFilePath(id: string) {
    // Ids are UUIDs; anything else could point outside the library folder
    if (!FILE_ID.test(id)) throw new Error("Invalid library file id");
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

let indexQueue: Promise<unknown> = Promise.resolve();

// Read, change and write the index one change at a time, writing through a temp file so it's never half written
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

export function readLibraryIndex(_: IpcMainInvokeEvent) {
    return readIndexFile();
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

// ---------- Soundboard ----------

const SOUND_URL = /^https:\/\/cdn\.discordapp\.com\/soundboard-sounds\/\d+$/;

// Downloads in the main process, where Discord's CDN CORS headers (broken on PTB/Canary) don't apply
export async function downloadSoundboardSound(_: IpcMainInvokeEvent, url: string) {
    if (!SOUND_URL.test(url)) throw new Error("Only Discord soundboard sounds can be downloaded");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed with status ${res.status}`);

    return {
        type: res.headers.get("content-type") ?? "audio/ogg",
        data: new Uint8Array(await res.arrayBuffer())
    };
}

// ---------- Screen share for the WebRTC voice engine ----------
// Discord's desktop app captures the screen through its native engine. With the WebRTC engine it calls
// getDisplayMedia like a browser, which Electron only allows through a display media request handler.

export interface ScreenSource {
    id: string;
    name: string;
    thumbnail: string;
    icon: string | null;
}

const CAPTURE_TYPES: ("screen" | "window")[] = ["screen", "window"];

let pendingSource: { id: string; audio: boolean; } | null = null;
const sessionsWithHandler = new WeakSet<Session>();

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

// Remembers the picked source for the next getDisplayMedia call from this window
export function selectScreenSource(event: IpcMainInvokeEvent, id: string, audio: boolean) {
    pendingSource = { id, audio };

    const { session } = event.sender;
    if (sessionsWithHandler.has(session)) return;
    sessionsWithHandler.add(session);

    session.setDisplayMediaRequestHandler((request, callback) => {
        const choice = pendingSource;
        pendingSource = null;

        // Nothing picked in our picker: deny, so getDisplayMedia rejects like a cancelled browser prompt
        if (!choice) return callback({});

        desktopCapturer.getSources({ types: CAPTURE_TYPES })
            .then(sources => {
                const source = sources.find(s => s.id === choice.id);
                if (!source) return callback({});

                callback({
                    video: source,
                    audio: choice.audio && request.audioRequested ? "loopback" : undefined
                });
            })
            .catch(() => callback({}));
    });
}
