/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

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
