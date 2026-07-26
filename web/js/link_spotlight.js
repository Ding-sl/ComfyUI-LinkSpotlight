// ComfyUI-LinkSpotlight
// Alt+H (remappable in Settings → Keybinding): show only the links touching
// the selected node(s) — every other link is hidden (or dimmed, depending on
// the settings). Press Alt+H again (or clear the selection, when auto-off is
// enabled) to restore the normal display.
//
// Implementation: non-destructive wrappers around the LGraphCanvas prototype
// (frontend 1.4x) — drawConnections() recomputes the focus set once per frame
// (so the spotlight follows the selection with no event wiring) and
// _renderAllLinkSegments() decides per link whether to draw, dim or skip.
// Nothing in the workflow is ever mutated: no hidden state can leak into the
// serialized JSON. Floating links and subgraph links go through the same
// render path and are covered automatically.
//
// Fragility note: _renderAllLinkSegments is an internal frontend API; if an
// update renames it, the patch disables itself cleanly (see patchCanvas)
// with a console error instead of breaking the canvas.

import { app } from "../../../scripts/app.js";

const EXT_NAME = "LinkSpotlight";
const COMMAND_ID = "LinkSpotlight.Toggle";

const SETTINGS = {
    dimAlpha: { id: "LinkSpotlight.DimAlpha", def: 0 },
    depth: { id: "LinkSpotlight.Depth", def: 1 },
    autoOff: { id: "LinkSpotlight.AutoOff", def: true },
    nodeAlpha: { id: "LinkSpotlight.NodeAlpha", def: 1 },
};

let spotlightActive = false;
let canvasPatched = false;

// IDs (normalized to String) recomputed at the start of every frame.
const selectedIds = new Set(); // selected nodes
const neighborIds = new Set(); // direct neighbors of the selection
let linkFocusIds = selectedIds; // set used to filter links

// Alphas cached once per frame (in drawConnections): the hot paths (per link,
// per node) must never query the settings store — one lookup per node per
// frame would add up on large graphs.
let frameDimAlpha = 0;
let frameNodeAlpha = 1;

function getSetting(key) {
    const s = SETTINGS[key];
    const value = app.extensionManager?.setting?.get?.(s.id);
    return value === undefined || value === null ? s.def : value;
}

// Hardened numeric read: a corrupted settings storage must never inject NaN
// into the alpha math.
function getNumericSetting(key) {
    const value = Number(getSetting(key));
    return Number.isFinite(value) ? value : SETTINGS[key].def;
}

function getLink(graph, linkId) {
    return graph._links?.get?.(linkId) ?? graph.links?.[linkId];
}

// Fills selectedIds/neighborIds from the current selection and picks the
// filtering set according to the depth setting (1 = links of the selected
// node only, 2 = every link of its direct neighbors too).
function computeFocus(canvas) {
    selectedIds.clear();
    neighborIds.clear();
    const graph = canvas.graph;
    const selected = canvas.selected_nodes ?? {};
    for (const key in selected) {
        const node = selected[key];
        if (node) selectedIds.add(String(node.id));
    }
    if (graph && selectedIds.size) {
        for (const key in selected) {
            const node = selected[key];
            if (!node) continue;
            for (const input of node.inputs ?? []) {
                if (input?.link == null) continue;
                const link = getLink(graph, input.link);
                if (link) neighborIds.add(String(link.origin_id));
            }
            for (const output of node.outputs ?? []) {
                for (const linkId of output?.links ?? []) {
                    const link = getLink(graph, linkId);
                    if (link) neighborIds.add(String(link.target_id));
                }
            }
        }
    }
    linkFocusIds = getNumericSetting("depth") >= 2
        ? new Set([...selectedIds, ...neighborIds])
        : selectedIds;
}

function isLinkFocused(link) {
    return linkFocusIds.has(String(link.origin_id))
        || linkFocusIds.has(String(link.target_id));
}

// A node stays fully visible when it is selected or a direct neighbor
// (regardless of the depth chosen for links).
function isNodeKept(node) {
    const id = String(node.id);
    return selectedIds.has(id) || neighborIds.has(id);
}

function patchCanvas() {
    const canvas = app.canvas;
    if (!canvas) {
        console.error(`${EXT_NAME}: app.canvas unavailable, feature disabled`);
        return false;
    }
    const proto = Object.getPrototypeOf(canvas);
    if (typeof proto.drawConnections !== "function"
        || typeof proto._renderAllLinkSegments !== "function"
        || typeof proto.drawNode !== "function") {
        console.error(
            `${EXT_NAME}: unexpected LGraphCanvas API (frontend update?), `
            + `feature disabled`,
        );
        return false;
    }

    const origDrawConnections = proto.drawConnections;
    proto.drawConnections = function (...args) {
        if (spotlightActive) {
            computeFocus(this);
            frameDimAlpha = getNumericSetting("dimAlpha");
            frameNodeAlpha = getNumericSetting("nodeAlpha");
            if (!selectedIds.size && getSetting("autoOff")) {
                spotlightActive = false;
            }
        }
        return origDrawConnections.apply(this, args);
    };

    const origRenderSegments = proto._renderAllLinkSegments;
    proto._renderAllLinkSegments = function (ctx, link, ...rest) {
        // Empty selection without auto-off: never blind the whole graph.
        if (!spotlightActive || !selectedIds.size || !link || isLinkFocused(link)) {
            return origRenderSegments.apply(this, arguments);
        }
        if (!(frameDimAlpha > 0)) return undefined; // link hidden
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * frameDimAlpha;
        try {
            return origRenderSegments.apply(this, arguments);
        } finally {
            ctx.globalAlpha = prevAlpha;
        }
    };

    // Optional dimming of out-of-focus nodes, through editor_alpha (used by
    // the node's whole internal rendering) rather than ctx.globalAlpha
    // (overwritten by drawNode). NodeAlpha = 1 → option inactive.
    const origDrawNode = proto.drawNode;
    proto.drawNode = function (node, ctx) {
        if (!spotlightActive || !selectedIds.size || frameNodeAlpha >= 1
            || !node || isNodeKept(node)) {
            return origDrawNode.apply(this, arguments);
        }
        const prevAlpha = this.editor_alpha;
        this.editor_alpha = prevAlpha * Math.max(frameNodeAlpha, 0.02);
        try {
            return origDrawNode.apply(this, arguments);
        } finally {
            this.editor_alpha = prevAlpha;
        }
    };

    // Redraw (background + foreground: links may be drawn on top with
    // links_ontop) as soon as the selection changes while the spotlight is
    // active — avoids a stale visual state when only the foreground is dirty.
    // Deliberately patched on the INSTANCE: onSelectionChange is a class
    // field of LGraphCanvas (an instance property initialized to undefined),
    // so a prototype patch would be shadowed and never called.
    const origOnSelectionChange = canvas.onSelectionChange;
    canvas.onSelectionChange = function (...args) {
        const r = origOnSelectionChange?.apply(this, args);
        if (spotlightActive) this.setDirty(true, true);
        return r;
    };

    return true;
}

// Called by the settings store on every value change: force a full frame
// (background + foreground) so the effect is immediate while the spotlight
// is active — the per-frame cache (frameDimAlpha/frameNodeAlpha) is refreshed
// by the drawConnections pass this redraw triggers.
function refreshCanvas() {
    if (spotlightActive) app.canvas?.setDirty(true, true);
}

function toggleSpotlight() {
    if (!canvasPatched) return;
    if (!spotlightActive) {
        // Same predicate as computeFocus (ignores stale falsy entries).
        const hasSelection =
            Object.values(app.canvas?.selected_nodes ?? {}).some(Boolean);
        if (!hasSelection) {
            app.extensionManager?.toast?.add?.({
                severity: "info",
                summary: "Link Spotlight",
                detail: "Select a node first to spotlight its links.",
                life: 3000,
            });
            return;
        }
    }
    spotlightActive = !spotlightActive;
    app.canvas?.setDirty(true, true);
}

app.registerExtension({
    name: EXT_NAME,
    commands: [
        {
            id: COMMAND_ID,
            label: "Toggle Link Spotlight (selected node links)",
            icon: "pi pi-eye",
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
            id: SETTINGS.depth.id,
            name: "Spotlight depth",
            type: "combo",
            options: [
                { text: "1 — links of the selected node", value: 1 },
                { text: "2 — links of direct neighbors too", value: 2 },
            ],
            defaultValue: SETTINGS.depth.def,
            category: ["LinkSpotlight", "Behavior", "Depth"],
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
            id: SETTINGS.nodeAlpha.id,
            name: "Opacity of out-of-focus nodes",
            type: "slider",
            attrs: { min: 0.1, max: 1, step: 0.05 },
            defaultValue: SETTINGS.nodeAlpha.def,
            tooltip: "1 = unrelated nodes left untouched (default).",
            category: ["LinkSpotlight", "Appearance", "Node opacity"],
            onChange: refreshCanvas,
        },
    ],
    setup() {
        canvasPatched = patchCanvas();
    },
});
