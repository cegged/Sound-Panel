/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import definePlugin from "@utils/types";

import { applyOutputDevice, installMicrophoneHook, isWebRTCEngineActive, uninstallMicrophoneHook } from "./audio/mixer";
import { disposePlayer } from "./audio/player";
import { PanelButton } from "./components/PanelButton";
import { revokeAllFileUrls } from "./data/library";
import { captureDesktopSource, installScreenShareHook, prepareDesktopSource, uninstallScreenShareHook } from "./screenshare/capture";
import { settings } from "./settings";
import { applyMaxVideoQuality, getStartBitrateParam, getVideoBitrateKbps, syncGoLiveQuality } from "./video/quality";

export default definePlugin({
    name: "SoundPanel",
    description: "Adds an advanced sound panel to the voice controls: play server soundboard sounds, your own sound effects and music through your microphone",
    authors: [{ name: "cegged", id: 453743721402466317n }],

    settings,

    settingsAboutComponent: () => (
        <Paragraph>
            GitHub: <Link href="https://github.com/cegged">cegged</Link>
        </Paragraph>
    ),

    patches: [
        // Voice panel action buttons (camera, screen share, activities, soundboard): add ours at the end
        {
            find: '"SoundboardRTCPanelButton"',
            replacement: {
                match: /(?<=\?\(0,\i\.jsx\)\(\i,\{channel:(\i),focusProps:\i\}\):null)\]/,
                replace: ",$self.renderPanelButton({channel:$1})]"
            }
        },
        // The native voice engine captures the microphone outside of JavaScript, so prefer WebRTC when enabled
        {
            find: ".WEBRTC].find(",
            predicate: () => IS_DISCORD_DESKTOP && settings.store.webrtcEngine,
            replacement: {
                match: /\[(\i\.\i\.NATIVE),(\i\.\i\.WEBRTC)\]/,
                replace: "[$2,$1]"
            }
        },
        // Discord only loads the WebRTC engine's DAVE (E2EE) module on the web platform.
        // Voice servers reject clients without DAVE (code 4017), so load it on desktop too
        {
            find: "startDavePreload(){",
            predicate: () => IS_DISCORD_DESKTOP && settings.store.webrtcEngine,
            replacement: [
                {
                    match: /(?<=fetchDave:)\(0,\i\.\i\)\(\)/,
                    replace: "!0"
                },
                {
                    match: /(?<=startDavePreload\(\)\{.{0,40}?)\(0,\i\.\i\)\(\)(?=&&\i\.fetchAsyncResources\()/,
                    replace: "!0"
                }
            ]
        },
        // The WebRTC engine only reports video support (camera and Go Live) for known browser names,
        // and the desktop app identifies as "Electron". Treat it like Chrome, which it is underneath
        {
            find: '"OculusBrowser"',
            predicate: () => IS_DISCORD_DESKTOP && settings.store.webrtcEngine,
            replacement: {
                match: /(?<=\i="Chrome"===(\i)\(\)\.name)(?=\|\|"Safari"===\i\(\)\.name\|\|"Firefox")/,
                replace: '||"Electron"===$1().name'
            }
        },
        // The Chromium inside Discord's desktop app has no H264 encoder (the native engine normally encodes video),
        // so with H264 negotiated the camera and Go Live send nothing. Rank VP8 first; H264 stays for decoding
        {
            find: "Unable to find a unique rtx SSRC!",
            predicate: () => IS_DISCORD_DESKTOP && settings.store.webrtcEngine,
            replacement: [
                {
                    match: /\[(\i\.\i)\.H265,\i\.\i\.H264,\i\.\i\.VP8,\i\.\i\.VP9\]/,
                    replace: "[$1.VP8,$1.VP9,$1.H265,$1.H264]"
                },
                {
                    match: /\[(\i\.\i)\.H264,\i\.\i\.VP8,\i\.\i\.VP9\]/,
                    replace: "[$1.VP8,$1.VP9,$1.H264]"
                },
                // The answer SDP caps all video at 2.5 Mbps. Give the stream connection its Go Live bitrate instead
                {
                    match: /videoBitRate:2500(?=,)/g,
                    replace: "videoBitRate:$self.getVideoBitrateKbps(this)"
                },
                {
                    match: /let (\i)=`x-google-max-bitrate=\$\{(\i)\}`/,
                    replace: "let $1=`x-google-max-bitrate=${$2}`+$self.getStartBitrateParam($2)"
                }
            ]
        },
        // Every video quality update of a WebRTC connection goes through here; apply max quality mode first
        {
            find: "mediaEngineConnectionId=`WebRTC-${",
            predicate: () => IS_DISCORD_DESKTOP && settings.store.webrtcEngine,
            replacement: {
                match: /updateVideoQuality\(\i\)\{(?=let \i=this\.videoStreamParameters\.findIndex\()/,
                replace: "$&$self.applyMaxVideoQuality(this);"
            }
        },
        // Discord's desktop Go Live window passes an Electron source id the WebRTC engine never captured.
        // Capture it before the stream starts, the way the web client does, and pass the engine's own input id on
        {
            find: '"startStreamWithSource"',
            predicate: () => IS_DISCORD_DESKTOP && settings.store.webrtcEngine,
            replacement: {
                match: /(if\(null==\i\)return\[!1,"no source"\];(\i)=\i\})(return\(0,\i\.\i\)\(\{preset:(\i),resolution:(\i),frameRate:(\i),soundshareEnabled:(\i)\}\))/,
                replace: "$1$2=await $self.prepareDesktopSource($2,{preset:$4,resolution:$5,frameRate:$6,audio:$7});$3"
            }
        },
        {
            find: "desktopInputPool.get(",
            predicate: () => IS_DISCORD_DESKTOP && settings.store.webrtcEngine,
            replacement: [
                // Fallback for source ids that still reach the engine uncaptured, e.g. switching sources mid-stream
                {
                    match: /(setGoLiveSource\((\i),(\i)\)\{.{0,200}?(\i)=this\.desktopInputPool\.get\(\2\.desktopDescription\.id\);)if\(null==\4\)return;/,
                    replace: "$1if(null==$4)return void $self.captureDesktopSource(this,$2,$3);"
                },
                // Screen capture is hard-coded to 30 FPS. Keep it as the default but let the stream's frame rate win
                {
                    match: /video:\{\.\.\.(\i),frameRate:30\}/,
                    replace: "video:{frameRate:30,...$1}"
                },
                // Setting a screen input only passes width and height to the quality manager. Also pass the frame rate
                // and update the max quality reported to the voice server, like Discord's native connection does
                {
                    match: /(\i)=\{width:"number"==typeof (\i)\.width.{0,160}?\},(\i)=\(\1\?\.height\?\?0\)>720\?(\i\.\i):(\i\.\i);this\.videoQualityManager\.setGoliveQuality\(\{encode:\1,capture:\1,bitrateMax:\3\}\)/,
                    replace: "$&,$self.syncGoLiveQuality(this,$2,$4,$5)"
                }
            ]
        }
    ],

    captureDesktopSource,
    prepareDesktopSource,
    syncGoLiveQuality,
    applyMaxVideoQuality,
    getVideoBitrateKbps,
    getStartBitrateParam,

    renderPanelButton: ErrorBoundary.wrap(PanelButton, { noop: true }),

    flux: {
        AUDIO_SET_OUTPUT_DEVICE() {
            void applyOutputDevice();
        }
    },

    start() {
        installMicrophoneHook();
        if (IS_DISCORD_DESKTOP && isWebRTCEngineActive()) installScreenShareHook();
    },

    stop() {
        disposePlayer();
        uninstallMicrophoneHook();
        uninstallScreenShareHook();
        revokeAllFileUrls();
    }
});
