/*
 * Sound Panel, a Vencord plugin
 * Copyright (c) 2026 cegged <https://github.com/cegged> (Discord: @c3g, ID 453743721402466317)
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { showToast } from "@webpack/common";

export const logger = new Logger("SoundPanel");

export function showError(message: string, err: unknown) {
    logger.error(message, err);
    showToast({ text: message, variant: "critical" });
}
