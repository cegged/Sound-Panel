/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import { desktopCapturer, IpcMainInvokeEvent, Session } from "electron";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";

import { applyIndexChange, type IndexChange, type LibraryItem } from "./data/libraryIndex";

export interface ScreenSource {
    id: string;
    name: string;
    thumbnail: string;
    icon: string | null;
}

interface ToolBuild {
    ytDlp: string;
    quickJs: string;
    quickJsHash: string;
}

// In Vencord's data folder, so Stable, PTB and Canary share one library
const LIBRARY_DIR = join(DATA_DIR, "SoundPanel");
const FILES_DIR = join(LIBRARY_DIR, "files");
const INDEX_FILE = join(LIBRARY_DIR, "library.json");
const TOOLS_DIR = join(LIBRARY_DIR, "tools");
const DOWNLOADS_DIR = join(LIBRARY_DIR, "downloads");

const SOUNDBOARD_URL = /^https:\/\/cdn\.discordapp\.com\/soundboard-sounds\/\d+$/;
const CAPTURE_TYPES: ("screen" | "window")[] = ["screen", "window"];

// YouTube audio comes through yt-dlp, which needs a JavaScript runtime to solve YouTube's challenges.
// QuickJS-NG is the smallest one it supports and stays on a version checked against GitHub's checksums.
// yt-dlp follows its latest release instead, because YouTube keeps breaking older ones.
const QUICKJS_VERSION = "v0.18.0";
const TOOL_BUILDS: Record<string, ToolBuild> = {
    "win32-x64": { ytDlp: "yt-dlp.exe", quickJs: "qjs-windows-x86_64.exe", quickJsHash: "ff03398d74ea6e6bd3a8e58058f7003225abcac229d7d57775b7aaae812a49c7" },
    "win32-ia32": { ytDlp: "yt-dlp_x86.exe", quickJs: "qjs-windows-x86.exe", quickJsHash: "79aa85a8208596dc04333e99726c254d43b9e814803f2100ea593341f2c95b0e" },
    "darwin-arm64": { ytDlp: "yt-dlp_macos", quickJs: "qjs-darwin-arm64", quickJsHash: "91fe89916d3b0a6c01c4dc8382a99c3c1fd91ecfc214aa81ca051902bcce590d" },
    "darwin-x64": { ytDlp: "yt-dlp_macos", quickJs: "qjs-darwin-x86_64", quickJsHash: "fa2c5dc78095daff566b32fab995ced12927875253b84216b91b834af2ef2b74" },
    "linux-x64": { ytDlp: "yt-dlp_linux", quickJs: "qjs-linux-x86_64", quickJsHash: "85ded23b9fabe8c1644fc40a8d2bbdd71157affcbd807359c618cc717ee24d7d" },
    "linux-arm64": { ytDlp: "yt-dlp_linux_aarch64", quickJs: "qjs-linux-aarch64", quickJsHash: "2c005c7171424a598d31c53c8dc4a0ae2e4958eb6fbb37908c885a307c78187c" }
};
const toolBuild: ToolBuild | undefined = TOOL_BUILDS[`${process.platform}-${process.arch}`];

const YOUTUBE_ID = /^[\w-]{11}$/;
const AUDIO_TYPES: Record<string, string> = { m4a: "audio/mp4", webm: "audio/webm", opus: "audio/ogg", ogg: "audio/ogg", mp3: "audio/mpeg" };

let indexQueue: Promise<unknown> = Promise.resolve();
let pendingSource: { id: string; audio: boolean; } | null = null;
const sessionsWithHandler = new WeakSet<Session>();
let toolsReady: Promise<void> | undefined;
let ytDlpUpdated = false;

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

function getTools() {
    if (!toolBuild) throw new Error("YouTube links don't work on this system");
    return { build: toolBuild, ytDlp: join(TOOLS_DIR, toolBuild.ytDlp), quickJs: join(TOOLS_DIR, toolBuild.quickJs) };
}

const exists = (path: string) => access(path).then(() => true, () => false);

async function download(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn't download ${basename(url)} (status ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
}

// Saved under a temp name first, so a cut-off download never counts as installed
async function installTool(path: string, data: Buffer, sha256: string) {
    if (createHash("sha256").update(data).digest("hex") !== sha256) throw new Error(`${basename(path)} doesn't match its checksum`);

    await writeFile(`${path}.tmp`, data, { mode: 0o755 });
    await rename(`${path}.tmp`, path);
}

async function installYtDlp(path: string, file: string) {
    const release = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
    const [sums, data] = await Promise.all([download(`${release}/SHA2-256SUMS`), download(`${release}/${file}`)]);
    const sha256 = sums.toString("utf8").split("\n").map(line => line.trim().split(/\s+/)).find(([, name]) => name === file)?.[0];
    if (!sha256) throw new Error(`yt-dlp's release has no checksum for ${file}`);

    await installTool(path, data, sha256);
}

function prepareTools() {
    toolsReady ??= (async () => {
        const { build, ytDlp, quickJs } = getTools();
        await mkdir(TOOLS_DIR, { recursive: true });

        if (!await exists(ytDlp)) await installYtDlp(ytDlp, build.ytDlp);
        if (!await exists(quickJs)) {
            const url = `https://github.com/quickjs-ng/quickjs/releases/download/${QUICKJS_VERSION}/${build.quickJs}`;
            await installTool(quickJs, await download(url), build.quickJsHash);
        }
    })().catch(err => {
        toolsReady = undefined;
        throw err;
    });

    return toolsReady;
}

export async function hasYouTubeTools(_: IpcMainInvokeEvent) {
    if (!toolBuild) return false;

    const { ytDlp, quickJs } = getTools();
    return await exists(ytDlp) && await exists(quickJs);
}

export function prepareYouTubeTools(_: IpcMainInvokeEvent) {
    return prepareTools();
}

function youTubeVideoId(link: string) {
    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    } catch {
        return null;
    }

    const host = url.hostname.replace(/^(www|m|music)\./, "");
    const id = host === "youtu.be" ? url.pathname.slice(1)
        : host === "youtube.com" ? url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/)?.[1]
            : undefined;

    return id && YOUTUBE_ID.test(id) ? id : null;
}

// yt-dlp reports problems as "ERROR: [youtube] <video id>: <reason>"
function ytDlpError(stderr: string) {
    const line = stderr.split(/\r?\n/).filter(l => l.startsWith("ERROR:")).pop();
    return line?.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, "");
}

function runYtDlp(path: string, args: string[]) {
    return new Promise<string>((done, fail) => {
        execFile(path, args, {
            timeout: 5 * 60 * 1000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            // yt-dlp is a Python program; this keeps titles in other alphabets intact
            env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
        }, (err, stdout, stderr) => err ? fail(new Error(ytDlpError(stderr) ?? err.message)) : done(stdout));
    });
}

// YouTube changes often break older yt-dlp versions, so update once per session before giving up
async function runYtDlpUpToDate(path: string, args: string[]) {
    try {
        return await runYtDlp(path, args);
    } catch (err) {
        if (ytDlpUpdated) throw err;

        ytDlpUpdated = true;
        await runYtDlp(path, ["--update"]).catch(() => { });
        return runYtDlp(path, args);
    }
}

export async function downloadYouTubeAudio(_: IpcMainInvokeEvent, link: string) {
    const videoId = youTubeVideoId(link.trim());
    if (!videoId) throw new Error("That isn't a link to a YouTube video");

    await prepareTools();
    const { ytDlp, quickJs } = getTools();
    const folder = join(DOWNLOADS_DIR, randomUUID());
    await mkdir(folder, { recursive: true });

    try {
        const output = await runYtDlpUpToDate(ytDlp, [
            "--ignore-config",
            "--no-playlist",
            "--cache-dir", join(TOOLS_DIR, "cache"),
            "--no-js-runtimes",
            "--js-runtimes", `quickjs:${quickJs}`,
            "--format", "bestaudio[ext=m4a]/bestaudio",
            "--max-filesize", "100M",
            "--match-filters", "duration <= 3600",
            "--output", join(folder, "audio.%(ext)s"),
            "--print", "after_move:%(.{title,duration,ext,filepath})j",
            "--", `https://www.youtube.com/watch?v=${videoId}`
        ]);

        // yt-dlp prints nothing when it skips a video for being too long or too big
        const line = output.trim().split(/\r?\n/).pop();
        if (!line) throw new Error("Only videos up to an hour long and 100 MB can be added");

        const info: { title?: string; duration?: number; ext?: string; filepath?: string; } = JSON.parse(line);
        if (!info.filepath || dirname(resolve(info.filepath)) !== resolve(folder)) throw new Error("yt-dlp saved the audio somewhere unexpected");

        const id = randomUUID();
        await mkdir(FILES_DIR, { recursive: true });
        await rename(info.filepath, libraryFilePath(id));

        return {
            id,
            name: info.title || "YouTube audio",
            mimeType: AUDIO_TYPES[info.ext ?? ""] ?? "audio/webm",
            size: (await stat(libraryFilePath(id))).size,
            duration: info.duration ?? 0
        };
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
}
