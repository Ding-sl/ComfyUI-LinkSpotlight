// ComfyUI-LinkSpotlight — extension entry point.
//
// Alt+H (remappable in Settings → Keybinding), the selection toolbox button
// or the node context menu: show only the links touching the selected
// node(s) or group(s) — every other link is hidden (or dimmed, depending on
// the settings). Traversal depth (1/2/3/∞) and direction (both/upstream/
// downstream) are configurable; an optional hover mode follows the node
// under the cursor when nothing is selected. While the canvas "hide links"
// button is on, a selection also reveals its links automatically (opt-out,
// no shortcut needed).
//
// This file only does registration (commands, keybinding, menus, settings).
// The focus computation lives in focus.js, the canvas patches in render.js
// and the shared state in state.js.

import { app } from "../../../scripts/app.js";
import {
    COMMAND_ID,
    EXT_NAME,
    FULL_TRACE,
    SETTINGS,
    getSetting,
    state,
} from "./state.js";
import { isGroupItem } from "./focus.js";
import { patchCanvas, refreshCanvas, updateIndicator } from "./render.js";
import { injectTopbarButton } from "./topbar.js";

// Logged at setup so a stale browser-cached copy of this file is easy to
// spot from the console.
const VERSION = "1.2.1";

function hasSpotlightTarget() {
    const canvas = app.canvas;
    if (Object.values(canvas?.selected_nodes ?? {}).some(Boolean)) return true;
    let hasGroup = false;
    canvas?.selectedItems?.forEach?.((item) => {
        if (isGroupItem(item)) hasGroup = true;
    });
    // Hover mode can start from an empty selection: the spotlight will
    // follow the cursor.
    return hasGroup || getSetting("hoverMode");
}

function toggleSpotlight() {
    if (!state.patched) return;
    if (!state.active && !hasSpotlightTarget()) {
        app.extensionManager?.toast?.add?.({
            severity: "info",
            summary: "Link Spotlight",
            detail: "Select a node or group first to spotlight its links.",
            life: 3000,
        });
        return;
    }
    state.active = !state.active;
    if (!state.active) {
        state.hoverNode = null;
        state.hoverNodeId = null;
    }
    updateIndicator();
    app.canvas?.setDirty(true, true);
}

function menuLabel() {
    return state.active ? "🔦 Link Spotlight off" : "🔦 Spotlight links";
}

app.registerExtension({
    name: EXT_NAME,
    commands: [
        {
            id: COMMAND_ID,
            label: "Toggle Link Spotlight (selected node links)",
            // Function form: the selection toolbox re-evaluates it on each
            // render, so the icon tracks the active state.
            icon: () => (state.active ? "pi pi-eye-slash" : "pi pi-eye"),
            function: toggleSpotlight,
        },
    ],
    // Plain "h" is taken by core (Comfy.Canvas.Lock) → Alt+H by default,
    // remappable in Settings → Keybinding.
    keybindings: [
        {
            combo: { key: "h", alt: true },
            commandId: COMMAND_ID,
        },
    ],
    // Floating toolbox above the selection: only visible when something is
    // selected, which is exactly when the toggle is usable.
    getSelectionToolboxCommands: () => [COMMAND_ID],
    getNodeMenuItems(node) {
        return [
            null, // separator
            {
                content: menuLabel(),
                callback: () => {
                    // Right-click does not always select: make the clicked
                    // node the target when nothing else is selected.
                    const canvas = app.canvas;
                    if (!state.active && canvas
                        && !Object.values(canvas.selected_nodes ?? {})
                            .some(Boolean)) {
                        canvas.selectNode?.(node);
                    }
                    toggleSpotlight();
                },
            },
        ];
    },
    // Escape hatch on the canvas menu, only while active (with auto-off
    // disabled the spotlight can outlive the selection).
    getCanvasMenuItems() {
        if (!state.active) return [];
        return [
            null,
            { content: "🔦 Link Spotlight off", callback: toggleSpotlight },
        ];
    },
    settings: [
        {
            id: SETTINGS.dimAlpha.id,
            name: "Opacity of out-of-focus links",
            type: "slider",
            attrs: { min: 0, max: 0.5, step: 0.01 },
            defaultValue: SETTINGS.dimAlpha.def,
            tooltip:
                "0 = links fully hidden while the spotlight is active; "
                + "~0.07 = dimmed but still faintly visible.",
            category: ["LinkSpotlight", "Appearance", "Link opacity"],
            onChange: refreshCanvas,
        },
        {
            id: SETTINGS.nodeAlpha.id,
            name: "Opacity of out-of-focus nodes",
            type: "slider",
            attrs: { min: 0.1, max: 1, step: 0.05 },
            defaultValue: SETTINGS.nodeAlpha.def,
            tooltip:
                "1 = unrelated nodes left untouched (default). "
                + "No effect in the Vue nodes beta (DOM-rendered nodes).",
            category: ["LinkSpotlight", "Appearance", "Node opacity"],
            onChange: refreshCanvas,
        },
        {
            id: SETTINGS.focusWidth.id,
            name: "Width boost of focused links",
            type: "slider",
            attrs: { min: 1, max: 3, step: 0.1 },
            defaultValue: SETTINGS.focusWidth.def,
            tooltip: "Draw the spotlighted links thicker. ×1 = off.",
            category: ["LinkSpotlight", "Appearance", "Focus width"],
            onChange: refreshCanvas,
        },
        {
            id: SETTINGS.focusGlow.id,
            name: "Glow of focused links",
            type: "slider",
            attrs: { min: 0, max: 20, step: 1 },
            defaultValue: SETTINGS.focusGlow.def,
            tooltip:
                "Golden glow (in pixels) around the spotlighted links. "
                + "0 = off.",
            category: ["LinkSpotlight", "Appearance", "Focus glow"],
            onChange: refreshCanvas,
        },
        {
            id: SETTINGS.showIndicator.id,
            name: "Show on-canvas indicator while active",
            type: "boolean",
            defaultValue: SETTINGS.showIndicator.def,
            tooltip:
                "Small pill at the top of the canvas reminding you the "
                + "spotlight is on (with its current depth/direction).",
            category: ["LinkSpotlight", "Appearance", "Indicator"],
            onChange: refreshCanvas,
        },
        {
            id: SETTINGS.depth.id,
            name: "Spotlight depth",
            type: "combo",
            options: [
                { text: "1 — links of the selected node(s)", value: 1 },
                { text: "2 — plus direct neighbors' links", value: 2 },
                { text: "3 — two hops out", value: 3 },
                { text: "∞ — full trace", value: FULL_TRACE },
            ],
            defaultValue: SETTINGS.depth.def,
            tooltip:
                "How far the spotlight spreads from the selection. Reroute "
                + "nodes are traversed for free and never consume a hop.",
            category: ["LinkSpotlight", "Behavior", "Depth"],
            onChange: refreshCanvas,
        },
        {
            id: SETTINGS.direction.id,
            name: "Traversal direction",
            type: "combo",
            options: [
                { text: "Both directions", value: "both" },
                { text: "Upstream — where the data comes from", value: "upstream" },
                { text: "Downstream — where the data goes", value: "downstream" },
            ],
            defaultValue: SETTINGS.direction.def,
            tooltip:
                "Upstream follows inputs only, downstream follows outputs "
                + "only. Combine with depth ∞ to trace a full lineage.",
            category: ["LinkSpotlight", "Behavior", "Direction"],
            onChange: refreshCanvas,
        },
        {
            id: SETTINGS.autoOff.id,
            name: "Turn off when the selection is cleared",
            type: "boolean",
            defaultValue: SETTINGS.autoOff.def,
            category: ["LinkSpotlight", "Behavior", "Auto-off"],
            onChange: refreshCanvas,
        },
        {
            id: SETTINGS.revealHidden.id,
            name: "Override the \"hide links\" button",
            type: "boolean",
            defaultValue: SETTINGS.revealHidden.def,
            tooltip:
                "While the canvas hide-links button is on, selecting node(s) "
                + "still reveals their links, using the depth/direction and "
                + "opacity settings above. Clear the selection and everything "
                + "hides again. Off = the button is absolute.",
            category: ["LinkSpotlight", "Behavior", "Override hide links"],
            onChange: refreshCanvas,
        },
        {
            id: SETTINGS.hoverMode.id,
            name: "Hover mode",
            type: "boolean",
            defaultValue: SETTINGS.hoverMode.def,
            tooltip:
                "While the spotlight is active and nothing is selected, it "
                + "follows the node under the cursor. Auto-off is ignored "
                + "while this is enabled.",
            category: ["LinkSpotlight", "Behavior", "Hover mode"],
            onChange: refreshCanvas,
        },
    ],
    setup() {
        console.info(`${EXT_NAME}: v${VERSION} loaded`);
        state.patched = patchCanvas();
        injectTopbarButton(toggleSpotlight);
    },
});
