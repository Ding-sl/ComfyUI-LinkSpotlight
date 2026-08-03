// ComfyUI-LinkSpotlight — shared state and settings access.
//
// Pure module: no side effects on import. ComfyUI imports every .js file in
// the web directory as an extension entry point, so only link_spotlight.js
// is allowed to register anything.

import { app } from "../../../scripts/app.js";

export const EXT_NAME = "LinkSpotlight";
export const COMMAND_ID = "LinkSpotlight.Toggle";

// Sentinel for the depth combo: "∞" is not JSON-serializable, so the full
// trace is stored as -1 in the settings store.
export const FULL_TRACE = -1;

// LinkRenderType values (frontend 1.4x): the canvas "hide links" button sets
// links_render_mode to HIDDEN_LINK, which makes drawConnections() return
// immediately — nothing of ours would ever run in that state.
export const HIDDEN_LINK = -1;
export const SPLINE_LINK = 2;

export const SETTINGS = {
    dimAlpha: { id: "LinkSpotlight.DimAlpha", def: 0 },
    depth: { id: "LinkSpotlight.Depth", def: 1 },
    autoOff: { id: "LinkSpotlight.AutoOff", def: true },
    nodeAlpha: { id: "LinkSpotlight.NodeAlpha", def: 1 },
    direction: { id: "LinkSpotlight.Direction", def: "both" },
    hoverMode: { id: "LinkSpotlight.HoverMode", def: false },
    focusWidth: { id: "LinkSpotlight.FocusWidth", def: 1 },
    focusGlow: { id: "LinkSpotlight.FocusGlow", def: 0 },
    showIndicator: { id: "LinkSpotlight.ShowIndicator", def: true },
    revealHidden: { id: "LinkSpotlight.RevealHidden", def: true },
};

export const state = {
    active: false,
    patched: false,
    // Recomputed once per frame by prepareFrame (render.js):
    seedIds: new Set(), // String node ids: selection + groups (+ hover)
    keptNodeIds: new Set(), // nodes reached by the traversal (stay visible)
    focusLinkIds: new Set(), // String link ids collected by the traversal
    // The kept nodes as objects: group dimming needs their geometry, not
    // just their id.
    keptNodes: [],
    // Hover mode: node currently under the pointer, tracked by our own
    // window-level pointermove hit-test (render.js). canvas.node_over is NOT
    // used as the primary source — the frontend skips node hit-testing
    // entirely in Vue nodes mode, so it never updates there.
    hoverNode: null,
    hoverNodeId: null,
    // Override of the canvas "hide links" button: while links are globally
    // hidden and something is seeded, the spotlight draws those links
    // anyway. Set once per frame in prepareFrame and read for the rest of
    // it by the link/node/group wrappers.
    overrideActive: false,
    // Whether this frame is in hidden-links mode with the override allowed,
    // and the canvas frame the per-frame state was computed for.
    frameReveal: false,
    lastPreparedFrame: -1,
    // The core toggle keeps the pre-hide render mode in a private closure
    // and the Comfy.LinkRenderMode setting reads HIDDEN_LINK while hidden,
    // so the last non-hidden mode is remembered here to draw the revealed
    // links with.
    lastVisibleRenderMode: SPLINE_LINK,
    // Per-frame caches: the hot paths (per link, per node) must never query
    // the settings store — one lookup per link per frame would add up on
    // large graphs.
    frameDimAlpha: 0,
    frameNodeAlpha: 1,
    frameFocusWidth: 1,
    frameFocusGlow: 0,
};

export function getSetting(key) {
    const s = SETTINGS[key];
    const value = app.extensionManager?.setting?.get?.(s.id);
    return value === undefined || value === null ? s.def : value;
}

// Hardened numeric read: a corrupted settings storage must never inject NaN
// into the alpha/width math.
export function getNumericSetting(key) {
    const value = Number(getSetting(key));
    return Number.isFinite(value) ? value : SETTINGS[key].def;
}
