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

import { applyOutputDevice, installMicrophoneHook, uninstallMicrophoneHook } from "./audio/mixer";
import { disposePlayer } from "./audio/player";
import { PanelButton } from "./components/PanelButton";
import { revokeAllFileUrls } from "./data/library";
import { settings } from "./settings";
import { detectVoiceEngine, getVoiceActivityThreshold, usesDesktopWebRTC } from "./webrtc/engine";
import { applyMaxVideoQuality, getStartBitrateParam, getVideoBitrateKbps, syncGoLiveQuality } from "./webrtc/quality";
import { captureDesktopSource, installScreenShareHook, prepareDesktopSource, uninstallScreenShareHook } from "./webrtc/screenShare";

// Patches that make Discord's WebRTC voice engine work in the desktop app
const webrtcMode = () => IS_DISCORD_DESKTOP && settings.store.webrtcEngine;

export default definePlugin({
    name: "SoundPanel",
    description: "Adds a sound panel to the voice controls: play soundboard sounds, your own sounds and music through your microphone",
    authors: [{ name: "cegged", id: 453743721402466317n }],

    settings,

    settingsAboutComponent: () => (
        <Paragraph>
            GitHub: <Link href="https://github.com/cegged">cegged</Link>
        </Paragraph>
    ),

    patches: [
        // Add our button after the soundboard button in the voice panel
        {
            find: '"SoundboardRTCPanelButton"',
            replacement: {
                match: /(?<=\?\(0,\i\.jsx\)\(\i,\{channel:(\i),focusProps:\i\}\):null)\]/,
                replace: ",$self.renderPanelButton({channel:$1})]"
            }
        },
        // The native engine captures the microphone outside of JavaScript, where we can't mix into it
        {
            find: ".WEBRTC].find(",
            predicate: webrtcMode,
            replacement: {
                match: /\[(\i\.\i\.NATIVE),(\i\.\i\.WEBRTC)\]/,
                replace: "[$2,$1]"
            }
        },
        // DAVE encryption is only loaded on the web, and voice servers reject clients without it
        {
            find: "startDavePreload(){",
            predicate: webrtcMode,
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
        // Video is only enabled for known browsers, and the desktop app reports itself as Electron
        {
            find: '"OculusBrowser"',
            predicate: webrtcMode,
            replacement: {
                match: /(?<=\i="Chrome"===(\i)\(\)\.name)(?=\|\|"Safari"===\i\(\)\.name\|\|"Firefox")/,
                replace: '||"Electron"===$1().name'
            }
        },
        {
            find: "Unable to find a unique rtx SSRC!",
            predicate: webrtcMode,
            replacement: [
                // The desktop app's Chromium can't encode H264, so prefer VP8 and keep H264 for decoding
                {
                    match: /\[(\i\.\i)\.H265,\i\.\i\.H264,\i\.\i\.VP8,\i\.\i\.VP9\]/,
                    replace: "[$1.VP8,$1.VP9,$1.H265,$1.H264]"
                },
                {
                    match: /\[(\i\.\i)\.H264,\i\.\i\.VP8,\i\.\i\.VP9\]/,
                    replace: "[$1.VP8,$1.VP9,$1.H264]"
                },
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
        // The desktop app only tells the voice server when you start speaking, since its native engine stops sending
        // audio while you're quiet. The WebRTC engine never stops, so like the web app it has to report every change,
        // or you show as speaking all the time, even while muted
        {
            find: "shouldSendSpeaking(",
            predicate: webrtcMode,
            replacement: {
                match: /(?<=shouldSendSpeaking\(\i,\i\)\{if\()\(0,\i\.\i\)\(\)(?=\)return!0)/,
                replace: "!0"
            }
        },
        // Automatic input sensitivity doesn't exist in the WebRTC engine, see getVoiceActivityThreshold
        {
            find: "this.input.setAudioMode(",
            predicate: webrtcMode,
            replacement: {
                match: /(?<=this\.input\.setAudioMode\(\i,\{delay:\i\.pttReleaseDelay,threshold:)(\i)\.vadThreshold/,
                replace: "$self.getVoiceActivityThreshold($1)"
            }
        },
        {
            find: "mediaEngineConnectionId=`WebRTC-${",
            predicate: webrtcMode,
            replacement: {
                match: /updateVideoQuality\(\i\)\{(?=let \i=this\.videoStreamParameters\.findIndex\()/,
                replace: "$&$self.applyMaxVideoQuality(this);"
            }
        },
        {
            find: '"startStreamWithSource"',
            predicate: webrtcMode,
            replacement: {
                match: /(if\(null==\i\)return\[!1,"no source"\];(\i)=\i\})(return\(0,\i\.\i\)\(\{preset:(\i),resolution:(\i),frameRate:(\i),soundshareEnabled:(\i)\}\))/,
                replace: "$1$2=await $self.prepareDesktopSource($2,{preset:$4,resolution:$5,frameRate:$6,audio:$7});$3"
            }
        },
        {
            find: "desktopInputPool.get(",
            predicate: webrtcMode,
            replacement: [
                {
                    match: /(setGoLiveSource\((\i),(\i)\)\{.{0,200}?(\i)=this\.desktopInputPool\.get\(\2\.desktopDescription\.id\);)if\(null==\4\)return;/,
                    replace: "$1if(null==$4)return void $self.captureDesktopSource(this,$2,$3);"
                },
                // Screen capture is hard-coded to 30 FPS
                {
                    match: /video:\{\.\.\.(\i),frameRate:30\}/,
                    replace: "video:{frameRate:30,...$1}"
                },
                {
                    match: /(\i)=\{width:"number"==typeof (\i)\.width.{0,160}?\},(\i)=\(\1\?\.height\?\?0\)>720\?(\i\.\i):(\i\.\i);this\.videoQualityManager\.setGoliveQuality\(\{encode:\1,capture:\1,bitrateMax:\3\}\)/,
                    replace: "$&,$self.syncGoLiveQuality(this,$2,$4,$5)"
                }
            ]
        }
    ],

    renderPanelButton: ErrorBoundary.wrap(PanelButton, { noop: true }),
    prepareDesktopSource,
    captureDesktopSource,
    syncGoLiveQuality,
    applyMaxVideoQuality,
    getVideoBitrateKbps,
    getStartBitrateParam,
    getVoiceActivityThreshold,

    flux: {
        AUDIO_SET_OUTPUT_DEVICE: applyOutputDevice
    },

    start() {
        detectVoiceEngine();
        installMicrophoneHook();
        if (usesDesktopWebRTC()) installScreenShareHook();
    },

    stop() {
        disposePlayer();
        uninstallMicrophoneHook();
        uninstallScreenShareHook();
        revokeAllFileUrls();
    }
});
