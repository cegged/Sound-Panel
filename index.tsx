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
        }
    ],

    renderPanelButton: ErrorBoundary.wrap(PanelButton, { noop: true }),

    flux: {
        AUDIO_SET_OUTPUT_DEVICE() {
            void applyOutputDevice();
        }
    },

    start() {
        installMicrophoneHook();
    },

    stop() {
        disposePlayer();
        uninstallMicrophoneHook();
        revokeAllFileUrls();
    }
});
