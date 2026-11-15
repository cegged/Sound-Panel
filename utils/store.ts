/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { FluxStore } from "@vencord/discord-types";
import { React, useEffect, useReducer } from "@webpack/common";

export interface Store<T extends object> {
    get(): T;
    set(patch: Partial<T>): void;
    subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
    let state = initial;
    const listeners = new Set<() => void>();

    return {
        get: () => state,
        set(patch) {
            state = { ...state, ...patch };
            listeners.forEach(listener => listener());
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}

export function useStore<T extends object>(store: Store<T>): T {
    return React.useSyncExternalStore(store.subscribe, store.get);
}

// Re-renders whenever any of the given Flux stores emit a change
export function useFluxStores(stores: FluxStore[]) {
    const [, rerender] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        stores.forEach(store => store.addChangeListener(rerender));
        return () => stores.forEach(store => store.removeChangeListener(rerender));
    }, []);
}

export function formatTime(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}
