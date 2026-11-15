/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { showToast, useState } from "@webpack/common";
import type { CSSProperties, ReactNode } from "react";

import { addFiles, LibraryKind } from "../data/library";
import { SearchIcon, UploadIcon } from "./icons";

export const cl = classNameFactory("vc-soundpanel-");

const logger = new Logger("SoundPanel");

export async function importFiles(files: File[], kind: LibraryKind) {
    if (!files.length) return;

    try {
        const { added, skipped } = await addFiles(files, kind);
        const target = kind === "music" ? "Music" : "My Sounds";

        if (added) showToast({ text: `Added ${added} file${added === 1 ? "" : "s"} to ${target}`, variant: "success" });
        if (skipped) showToast({ text: `Skipped ${skipped} file${skipped === 1 ? "" : "s"} that ${skipped === 1 ? "isn't" : "aren't"} audio`, variant: "critical" });
    } catch (err) {
        logger.error("Failed to import files", err);
        showToast({ text: "Couldn't save the files", variant: "critical" });
    }
}

export function pickFiles(kind: LibraryKind) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.multiple = true;
    input.onchange = () => void importFiles([...input.files ?? []], kind);
    input.click();
}

export function UploadButton({ kind, label }: { kind: LibraryKind; label: string; }) {
    return (
        <button type="button" className={cl("action-button", "primary")} onClick={() => pickFiles(kind)}>
            <UploadIcon size={16} />
            <span>{label}</span>
        </button>
    );
}

export function FileDropZone({ kind, children }: { kind: LibraryKind; children: ReactNode; }) {
    const [dragging, setDragging] = useState(false);
    const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

    return (
        <div
            className={cl("dropzone")}
            onDragOver={e => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                setDragging(true);
            }}
            onDragLeave={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={e => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                setDragging(false);
                void importFiles([...e.dataTransfer.files], kind);
            }}
        >
            {children}
            {dragging && (
                <div className={cl("dropzone-overlay")}>
                    <UploadIcon size={32} />
                    <span>Drop audio files to add them to {kind === "music" ? "Music" : "My Sounds"}</span>
                </div>
            )}
        </div>
    );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange(value: string): void; placeholder: string; }) {
    return (
        <label className={cl("search")}>
            <SearchIcon size={16} />
            <input
                type="text"
                value={value}
                placeholder={placeholder}
                spellCheck={false}
                onChange={e => onChange(e.currentTarget.value)}
            />
        </label>
    );
}

interface RangeSliderProps {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    label: string;
    className?: string;
    onChange(value: number): void;
}

export function RangeSlider({ value, min = 0, max = 100, step = 1, label, className, onChange }: RangeSliderProps) {
    const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;

    return (
        <input
            type="range"
            className={classes(cl("range"), className)}
            min={min}
            max={max}
            step={step}
            value={value}
            aria-label={label}
            style={{ "--vc-soundpanel-fill": `${fill}%` } as CSSProperties}
            onChange={e => onChange(Number(e.currentTarget.value))}
        />
    );
}

export function RenameInput({ initialValue, onDone }: { initialValue: string; onDone(value: string | null): void; }) {
    const [value, setValue] = useState(initialValue);
    const commit = () => onDone(value.trim() || null);

    return (
        <input
            className={cl("rename-input")}
            value={value}
            autoFocus
            maxLength={100}
            onFocus={e => e.currentTarget.select()}
            onChange={e => setValue(e.currentTarget.value)}
            onClick={e => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={e => {
                e.stopPropagation();
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") onDone(null);
            }}
        />
    );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode; }) {
    return (
        <div className={cl("empty")}>
            <div className={cl("empty-icon")}>{icon}</div>
            <div className={cl("empty-title")}>{title}</div>
            {children && <div className={cl("empty-body")}>{children}</div>}
        </div>
    );
}

export function matchesQuery(name: string, query: string) {
    return name.toLowerCase().includes(query.trim().toLowerCase());
}
