/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import type { Channel } from "@vencord/discord-types";
import { useEffect } from "@webpack/common";
import type { ComponentType } from "react";

import { stopAll, useIsPlaying } from "../audio/player";
import { refreshLibrary } from "../data/library";
import { PanelTab, settings } from "../settings";
import { cl } from "./common";
import { IconProps, MusicNoteIcon, SoundboardIcon, SoundPanelIcon, StopIcon, WaveformIcon } from "./icons";
import { MusicTab } from "./MusicTab";
import { MySoundsTab } from "./MySoundsTab";
import { OutputControls } from "./OutputControls";
import { ServerSoundsTab } from "./ServerSoundsTab";

const TABS: { id: PanelTab; label: string; icon: ComponentType<IconProps>; }[] = [
    { id: "server", label: "Soundboard", icon: SoundboardIcon },
    { id: "sounds", label: "My Sounds", icon: WaveformIcon },
    { id: "music", label: "Music", icon: MusicNoteIcon }
];

function SoundPanelPopout({ channel }: { channel?: Channel; }) {
    const activeTab = settings.use(["activeTab"]).activeTab as PanelTab;
    const isPlaying = useIsPlaying();

    useEffect(() => {
        void refreshLibrary();
    }, []);

    return (
        <div className={cl("popout")} role="dialog" aria-label="Sound Panel">
            <header className={cl("header")}>
                <div className={cl("title-row")}>
                    <span className={cl("badge")}><SoundPanelIcon size={18} /></span>
                    <span className={cl("title")}>Sound Panel</span>
                    <button
                        type="button"
                        className={cl("icon-button", "stop-all")}
                        aria-label="Stop all"
                        title="Stop all"
                        disabled={!isPlaying}
                        onClick={stopAll}
                    >
                        <StopIcon size={18} />
                    </button>
                </div>
                <nav className={cl("tabs")} role="tablist">
                    {TABS.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === id}
                            className={cl("tab-button", { "tab-button-active": activeTab === id })}
                            onClick={() => settings.store.activeTab = id}
                        >
                            <Icon size={16} />
                            <span>{label}</span>
                        </button>
                    ))}
                </nav>
            </header>

            <div className={cl("body")}>
                {activeTab === "sounds" ? <MySoundsTab />
                    : activeTab === "music" ? <MusicTab />
                        : <ServerSoundsTab channel={channel} />}
            </div>

            <OutputControls channel={channel} />
        </div>
    );
}

export default ErrorBoundary.wrap(SoundPanelPopout, { noop: false });
