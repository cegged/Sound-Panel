/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { openUserProfile } from "@utils/discord";
import type { Channel, User } from "@vencord/discord-types";
import { useEffect, UserStore, UserUtils, useState, useStateFromStores } from "@webpack/common";
import type { ComponentType } from "react";

import { stopAll, useIsPlaying } from "../audio/player";
import { refreshLibrary } from "../data/library";
import { PanelTab, settings } from "../settings";
import { showError } from "../utils/logger";
import { cl } from "./common";
import { IconProps, MusicNoteIcon, SoundboardIcon, SoundPanelIcon, StopIcon, WaveformIcon } from "./icons";
import { MusicTab } from "./MusicTab";
import { MySoundsTab } from "./MySoundsTab";
import { OutputControls } from "./OutputControls";
import { ServerSoundsTab } from "./ServerSoundsTab";

// The credit next to the title opens the author's Discord profile
const AUTHOR = { id: "453743721402466317", username: "c3g" };

const TABS: { id: PanelTab; label: string; icon: ComponentType<IconProps>; }[] = [
    { id: "server", label: "Soundboard", icon: SoundboardIcon },
    { id: "sounds", label: "My Sounds", icon: WaveformIcon },
    { id: "music", label: "Music", icon: MusicNoteIcon }
];

// The author's Discord account, fetched once if this Discord app hasn't seen it yet
function useAuthor() {
    const cached = useStateFromStores([UserStore], () => UserStore.getUser(AUTHOR.id));
    const [fetched, setFetched] = useState<User | null>(null);

    useEffect(() => {
        if (cached) return;

        let mounted = true;
        UserUtils.getUser(AUTHOR.id).then(user => mounted && setFetched(user), () => { });
        return () => { mounted = false; };
    }, [cached]);

    return cached ?? fetched;
}

function AuthorCredit() {
    const author = useAuthor();

    return (
        <button
            type="button"
            className={cl("credit")}
            title="Open profile"
            onClick={() => openUserProfile(AUTHOR.id).catch(err => showError("Couldn't open the profile", err))}
        >
            {author
                ? <img className={cl("credit-avatar")} src={author.getAvatarURL(undefined, 64)} alt="" />
                : <span className={cl("credit-avatar")} />}
            <span className={cl("credit-text")}>Made by @{author?.username ?? AUTHOR.username}</span>
        </button>
    );
}

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
                    <div className={cl("title-group")}>
                        <span className={cl("title")}>Sound Panel</span>
                        <AuthorCredit />
                    </div>
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
