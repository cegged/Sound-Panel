/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// native.ts uses this in the main process too, so no renderer imports in here

const VIDEO_ID = /^[\w-]{11}$/;

// The video's id in a YouTube link (watch, youtu.be, shorts and live links, with or without https://), or null
export function youTubeVideoId(link: string) {
    const text = link.trim();
    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }

    const host = url.hostname.replace(/^(www|m|music)\./, "");
    const id = host === "youtu.be" ? url.pathname.slice(1)
        : host === "youtube.com" ? url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/)?.[1]
            : undefined;

    return id && VIDEO_ID.test(id) ? id : null;
}
