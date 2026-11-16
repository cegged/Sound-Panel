/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { execFile, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { desktopCapturer, IpcMainInvokeEvent, Session } from "electron";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";

import { applyIndexChange, type IndexChange, type LibraryItem } from "./data/libraryIndex";
import { youTubeVideoId } from "./utils/youtube";

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
const COVERS_DIR = join(LIBRARY_DIR, "covers");
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

const AUDIO_TYPES: Record<string, string> = { m4a: "audio/mp4", webm: "audio/webm", opus: "audio/ogg", ogg: "audio/ogg", mp3: "audio/mpeg" };

let indexQueue: Promise<unknown> = Promise.resolve();
let pendingSource: { id: string; audio: boolean; } | null = null;
const sessionsWithHandler = new WeakSet<Session>();
let toolsReady: Promise<void> | undefined;
let ytDlpUpdated = false;
let jsRuntime: Promise<string> | undefined;

// A YouTube song downloading in the background, under the id it gets in the library
interface YouTubeDownload {
    videoId: string;
    folder: string;
    // The audio file: in the download folder while yt-dlp writes it, in the library once it's done
    path?: string;
    preview?: { title: string; channel?: string; };
    details?: { title?: string; channel?: string; duration?: number; ext?: string; acodec?: string; };
    coverSaved: Promise<boolean>;
    cover: boolean;
    progress: number | null;
    item?: LibraryItem;
    error?: string;
}

const youTubeDownloads = new Map<string, YouTubeDownload>();
// The most audio one request hands to the panel, so a long song arrives in pieces
const MAX_CHUNK = 1024 * 1024;

// Ids are UUIDs; anything else could point outside the library folder
function checkId(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid library file id");
    return id;
}

const libraryFilePath = (id: string) => join(FILES_DIR, checkId(id));
const coverFilePath = (id: string) => join(COVERS_DIR, `${checkId(id)}.jpg`);

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

async function readIfExists(path: string) {
    try {
        return new Uint8Array(await readFile(path));
    } catch (err) {
        if (isMissing(err)) return null;
        throw err;
    }
}

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

export function changeLibraryIndex(_: IpcMainInvokeEvent, change: IndexChange) {
    return changeIndex(change);
}

// One change at a time, written through a temp file so the index is never left half written
function changeIndex(change: IndexChange) {
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
    return readIfExists(libraryFilePath(id));
}

export async function readLibraryCover(_: IpcMainInvokeEvent, id: string) {
    return readIfExists(coverFilePath(id));
}

export async function deleteLibraryFile(_: IpcMainInvokeEvent, id: string) {
    await rm(libraryFilePath(id), { force: true });
    await rm(coverFilePath(id), { force: true });
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

// yt-dlp reports problems as "ERROR: [youtube] <video id>: <reason>"
function ytDlpError(stderr: string) {
    const line = stderr.split(/\r?\n/).filter(l => l.startsWith("ERROR:")).pop();
    return line?.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, "");
}

// Resolves with everything yt-dlp printed, and hands over each printed line as it arrives
function runYtDlp(path: string, args: string[], onLine?: (line: string) => void) {
    return new Promise<string>((done, fail) => {
        const child = spawn(path, args, {
            windowsHide: true,
            // yt-dlp is a Python program; this keeps titles in other alphabets intact
            env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
        });
        const timeout = setTimeout(() => child.kill(), 5 * 60 * 1000);
        let stdout = "";
        let stderr = "";
        let partialLine = "";

        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
            const lines = (partialLine + chunk).split(/\r?\n/);
            partialLine = lines.pop()!;
            if (onLine) lines.forEach(onLine);
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

        child.on("error", err => {
            clearTimeout(timeout);
            fail(err);
        });
        child.on("close", code => {
            clearTimeout(timeout);
            if (code === 0) done(stdout);
            else fail(new Error(ytDlpError(stderr) ?? `yt-dlp stopped with exit code ${code}`));
        });
    });
}

// YouTube changes often break older yt-dlp versions, so update once per session before giving up
async function runYtDlpUpToDate(path: string, args: string[], onLine?: (line: string) => void) {
    try {
        return await runYtDlp(path, args, onLine);
    } catch (err) {
        if (ytDlpUpdated) throw err;

        ytDlpUpdated = true;
        await runYtDlp(path, ["--update"]).catch(() => { });
        return runYtDlp(path, args, onLine);
    }
}

// YouTube's medium thumbnail is 16:9 without black bars, so it crops cleanly to a square cover.
// A missing cover shouldn't cost the song, so failures only mean no cover.
async function saveCover(videoId: string, id: string) {
    try {
        const image = await download(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);
        await mkdir(COVERS_DIR, { recursive: true });
        await writeFile(coverFilePath(id), image);
        return true;
    } catch {
        return false;
    }
}

// Node.js finds a YouTube video about 3 seconds sooner than QuickJS, but runs YouTube's code with less
// isolation. Without Node.js 20 or newer on the PATH, QuickJS does it.
function getJsRuntime(quickJs: string) {
    return jsRuntime ??= new Promise(resolve => {
        execFile("node", ["--version"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
            const major = Number(/^v(\d+)\./.exec(String(stdout).trim())?.[1] ?? 0);
            resolve(!err && major >= 20 ? "node" : `quickjs:${quickJs}`);
        });
    });
}

// YouTube's oEmbed answers in a fraction of a second, long before yt-dlp has found the video
async function fetchPreview(videoId: string) {
    try {
        const video = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
        const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${video}`);
        if (!res.ok) return undefined;

        const data: { title?: string; author_name?: string; } = await res.json();
        return data.title ? { title: data.title, channel: data.author_name } : undefined;
    } catch {
        return undefined;
    }
}

// The bytes of a file from offset onwards, or null when there are none yet
async function readChunk(path: string, offset: number) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
        handle = await open(path, "r");
    } catch (err) {
        // Not written yet, or just moved into the library
        if (isMissing(err)) return null;
        throw err;
    }

    try {
        const { size } = await handle.stat();
        const length = Math.min(size - offset, MAX_CHUNK);
        if (length <= 0) return null;

        const bytes = new Uint8Array(length);
        const { bytesRead } = await handle.read(bytes, 0, length, offset);
        return bytes.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

function parseLine<T>(line: string): T | undefined {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
}

async function runYouTubeDownload(id: string, download: YouTubeDownload) {
    try {
        const { ytDlp, quickJs } = getTools();
        await mkdir(download.folder, { recursive: true });

        const output = await runYtDlpUpToDate(ytDlp, [
            "--ignore-config",
            "--no-playlist",
            "--cache-dir", join(TOOLS_DIR, "cache"),
            "--no-js-runtimes",
            "--js-runtimes", await getJsRuntime(quickJs),
            // Stereo Opus first: it plays while it downloads, and leaves out the large surround tracks some videos have
            "--format", "bestaudio[acodec=opus]/bestaudio[ext=m4a][audio_channels<=2]/bestaudio[audio_channels<=2]/bestaudio",
            "--max-filesize", "100M",
            "--match-filters", "duration <= 3600",
            "--output", join(download.folder, "audio.%(ext)s"),
            // Written under its final name from the first byte, so the panel can play it while it grows
            "--no-part",
            "--progress",
            "--newline",
            "--progress-template", "download:progress %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s",
            "--print", "before_dl:%(.{title,channel,duration,ext,acodec})j",
            "--print", "after_move:%(.{title,channel,duration,ext,filepath})j",
            "--", `https://www.youtube.com/watch?v=${download.videoId}`
        ], line => {
            const progress = /^progress (\d+) (\d+)/.exec(line);
            if (progress) {
                download.progress = Math.min(Number(progress[1]) / Number(progress[2]), 1);
            } else if (line.startsWith("{") && !line.includes("\"filepath\"")) {
                download.details = parseLine(line);
                if (download.details?.ext) download.path = join(download.folder, `audio.${download.details.ext}`);
            }
        });

        // yt-dlp prints no details when it skips a video for being too long or too big
        const line = output.trim().split(/\r?\n/).filter(l => l.startsWith("{") && l.includes("\"filepath\"")).pop();
        const info = line && parseLine<{ title?: string; channel?: string; duration?: number; ext?: string; filepath?: string; }>(line);
        if (!info) throw new Error("Only videos up to an hour long and 100 MB can be added");
        if (!info.filepath || dirname(resolve(info.filepath)) !== resolve(download.folder)) throw new Error("yt-dlp saved the audio somewhere unexpected");

        await mkdir(FILES_DIR, { recursive: true });
        await rename(info.filepath, libraryFilePath(id));
        download.path = libraryFilePath(id);

        const item: LibraryItem = {
            id,
            name: info.title || download.preview?.title || "YouTube audio",
            kind: "music",
            mimeType: AUDIO_TYPES[info.ext ?? ""] ?? "audio/webm",
            size: (await stat(libraryFilePath(id))).size,
            duration: info.duration ?? 0,
            volume: 1,
            addedAt: Date.now(),
            artist: info.channel,
            youtubeId: download.videoId,
            cover: await download.coverSaved
        };

        // Added here rather than by the panel, so the song is kept even if Discord's window reloads first
        await changeIndex({ type: "add", items: [item] });
        download.item = item;
        download.progress = 1;
    } catch (err) {
        download.error = err instanceof Error ? err.message : String(err);

        // A song that isn't added leaves nothing behind
        await download.coverSaved;
        await Promise.all([rm(libraryFilePath(id), { force: true }), rm(coverFilePath(id), { force: true })]).catch(() => { });
    } finally {
        // Nobody waits for this download, so a failed cleanup can't be allowed to throw
        await rm(download.folder, { recursive: true, force: true }).catch(() => { });
    }
}

// Starts downloading a YouTube song in the background and returns the id it gets in the library
export async function startYouTubeDownload(_: IpcMainInvokeEvent, link: string) {
    const videoId = youTubeVideoId(link);
    if (!videoId) throw new Error("That isn't a link to a YouTube video");

    // Pasted again after Discord's window reloaded and forgot it, so the download already running carries on
    for (const [id, running] of youTubeDownloads) {
        if (running.videoId === videoId && !running.item && !running.error) return id;
    }

    await prepareTools();

    const id = randomUUID();
    const download: YouTubeDownload = {
        videoId,
        folder: join(DOWNLOADS_DIR, id),
        coverSaved: saveCover(videoId, id),
        cover: false,
        progress: null
    };
    youTubeDownloads.set(id, download);

    void download.coverSaved.then(saved => { download.cover = saved; });
    void fetchPreview(videoId).then(preview => { download.preview = preview; });
    void runYouTubeDownload(id, download);

    return id;
}

// How a background download is doing, with its audio from offset onwards (none for a negative offset).
// Null once the panel has said it's done with the download.
export async function getYouTubeDownload(_: IpcMainInvokeEvent, id: string, offset: number) {
    const download = youTubeDownloads.get(checkId(id));
    if (!download) return null;

    const { details, preview } = download;
    return {
        title: details?.title || preview?.title,
        channel: details?.channel || preview?.channel,
        duration: details?.duration ?? 0,
        // Only WebM plays while it downloads: YouTube's M4A files aren't split into the fragments that needs
        streamType: details?.ext === "webm" ? `audio/webm; codecs="${details.acodec ?? "opus"}"` : null,
        cover: download.cover,
        progress: download.progress,
        bytes: offset >= 0 && download.path ? await readChunk(download.path, offset) : null,
        item: download.item ?? null,
        error: download.error ?? null
    };
}

// The panel has the song, or its error, so the download can be forgotten
export function finishYouTubeDownload(_: IpcMainInvokeEvent, id: string) {
    youTubeDownloads.delete(checkId(id));
}
