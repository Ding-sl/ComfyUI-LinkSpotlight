// ComfyUI-LinkSpotlight — canvas patches.
//
// Non-destructive wrappers around the LGraphCanvas prototype (frontend 1.4x):
// prepareFrame() recomputes the focus set once per frame (so the spotlight
// follows the selection with no event wiring), _renderAllLinkSegments()
// decides per link whether to draw, emphasize, dim or skip, and drawNode() /
// getNodeModeAlpha() / LGraphGroup.draw() optionally dim out-of-focus nodes
// and groups. Nothing in the workflow is ever mutated: no hidden state can
// leak into the serialized JSON. Floating links and subgraph links go through
// the same render path and are covered automatically.
//
// The spotlight also overrides the canvas "hide links" button
// (Comfy.LinkRenderMode = HIDDEN_LINK): while links are globally hidden,
// seeding a selection reveals its links — no shortcut needed — and clearing
// it follows the button again. drawConnections() bails out immediately in
// hidden mode, so the wrapper temporarily restores the last non-hidden
// render mode for that single call, then puts HIDDEN_LINK back in a finally
// block. (Hidden-links override and node-mode/group dimming ported from the
// buzzworks-be fork, by Kieran Marien.)
//
// Fragility note: _renderAllLinkSegments is an internal frontend API; if an
// update renames it, the patch disables itself cleanly (see patchCanvas)
// with a console error instead of breaking the canvas.

import { app } from "../../../scripts/app.js";
import {
    EXT_NAME,
    FULL_TRACE,
    HIDDEN_LINK,
    getNumericSetting,
    getSetting,
    state,
} from "./state.js";
import { computeFocus, isLinkFocused, isNodeKept } from "./focus.js";
import { updateTopbarButton } from "./topbar.js";

// Golden glow reads on both dark and light canvas themes.
const FOCUS_GLOW_COLOR = "#ffd54f";

// LGraphGroup prototypes already wrapped (reached through a live group, the
// class itself is not exported to extensions).
const patchedGroupProtos = new WeakSet();

// Called by the settings store on every value change: force a full frame
// (background + foreground) so the effect is immediate while the spotlight
// (or the hidden-links override) is active — the per-frame caches are
// refreshed by the prepareFrame pass this redraw triggers.
export function refreshCanvas() {
    updateIndicator();
    const canvas = app.canvas;
    if (!canvas) return;
    if (state.active || canvas.links_render_mode === HIDDEN_LINK) {
        canvas.setDirty(true, true);
    }
}

// ---------------------------------------------------------------------------
// "Spotlight active" indicator — a DOM pill, NOT a canvas drawing: the front
// canvas is neither reliably redrawn nor even guaranteed to be the visible
// layer (Vue nodes mode renders nodes in DOM), so anything painted there can
// silently never show. A fixed-position element works in every render mode.

let indicatorEl = null;

function indicatorLabel() {
    const parts = [];
    const depth = getNumericSetting("depth");
    if (depth === FULL_TRACE) parts.push("depth ∞");
    else if (depth > 1) parts.push(`depth ${depth}`);
    const direction = getSetting("direction");
    if (direction !== "both") parts.push(direction);
    return parts.length
        ? `🔦 Link Spotlight · ${parts.join(" · ")}`
        : "🔦 Link Spotlight";
}

function ensureIndicator() {
    if (indicatorEl) return indicatorEl;
    indicatorEl = document.createElement("div");
    Object.assign(indicatorEl.style, {
        position: "fixed",
        transform: "translateX(-50%)",
        background: "rgba(20, 20, 20, 0.85)",
        color: "#eee",
        border: "1px solid rgba(255, 213, 79, 0.55)",
        borderRadius: "12px",
        padding: "3px 10px",
        font: "12px sans-serif",
        whiteSpace: "nowrap",
        zIndex: "900",
        pointerEvents: "none",
        display: "none",
    });
    document.body.appendChild(indicatorEl);
    return indicatorEl;
}

// Refreshes every activity indicator (topbar button highlight + pill).
// Called from every place the active state or the relevant settings can
// change (toggle, settings onChange, auto-off).
export function updateIndicator() {
    updateTopbarButton();
    const show = state.active && !!getSetting("showIndicator");
    if (!indicatorEl && !show) return;
    const el = ensureIndicator();
    if (!show) {
        el.style.display = "none";
        return;
    }
    el.textContent = indicatorLabel();
    // Centered over the graph canvas, just under its top edge (below the
    // topbar), re-anchored on every show.
    const rect = app.canvas?.canvas?.getBoundingClientRect?.();
    el.style.left = rect ? `${rect.left + rect.width / 2}px` : "50%";
    el.style.top = `${Math.max(rect?.top ?? 0, 0) + 8}px`;
    el.style.display = "block";
}

// ---------------------------------------------------------------------------
// Hover tracking — our own window-level pointermove hit-test, NOT
// canvas.node_over: the frontend skips node hit-testing entirely in Vue
// nodes mode (nodes are DOM elements that swallow pointer events), so
// node_over never updates there. A capture-phase listener sees the moves in
// every mode; the hit-test is rAF-throttled and runs only while engaged.

let pendingHoverEvent = null;

function processHoverEvent() {
    const event = pendingHoverEvent;
    pendingHoverEvent = null;
    if (!event) return;
    const canvas = app.canvas;
    const graph = canvas?.graph;
    if (!graph) return;
    const engaged = state.active
        || (canvas.links_render_mode === HIDDEN_LINK
            && getSetting("revealHidden"));
    if (!engaged || !getSetting("hoverMode")) return;
    if (typeof canvas.convertEventToCanvasOffset !== "function"
        || typeof graph.getNodeOnPos !== "function") {
        return;
    }
    const pos = canvas.convertEventToCanvasOffset(event);
    const node = graph.getNodeOnPos(pos[0], pos[1]) ?? null;
    const hoverId = node ? String(node.id) : null;
    if (hoverId !== state.hoverNodeId) {
        state.hoverNodeId = hoverId;
        state.hoverNode = node;
        // Links live on the background canvas: force both layers.
        canvas.setDirty(true, true);
    }
}

function onPointerMove(event) {
    // Cheapest possible pre-guard for the idle case.
    if (!state.active
        && app.canvas?.links_render_mode !== HIDDEN_LINK) {
        return;
    }
    if (!pendingHoverEvent) requestAnimationFrame(processHoverEvent);
    pendingHoverEvent = event;
}

// Per-frame state: the focus set and the cached alphas everything else
// reads. drawBackCanvas paints groups BEFORE links, so this cannot live in
// the drawConnections wrapper alone — the group wrapper would then dim
// against the previous frame's selection and stay a click behind. Whichever
// wrapper runs first primes the frame; later calls are no-ops
// (LGraphCanvas.frame is bumped once per draw(), so it is stable within a
// frame).
function prepareFrame(canvas) {
    if (canvas.frame != null && canvas.frame === state.lastPreparedFrame) {
        return;
    }
    state.lastPreparedFrame = canvas.frame;

    const hidden = canvas.links_render_mode === HIDDEN_LINK;
    if (!hidden) state.lastVisibleRenderMode = canvas.links_render_mode;
    state.frameReveal = hidden && !!getSetting("revealHidden");
    state.overrideActive = false;

    if (state.active || state.frameReveal) {
        computeFocus(canvas);
        state.frameDimAlpha = getNumericSetting("dimAlpha");
        state.frameNodeAlpha = getNumericSetting("nodeAlpha");
        state.frameFocusWidth = getNumericSetting("focusWidth");
        state.frameFocusGlow = getNumericSetting("focusGlow");
        // Hover mode keeps the spotlight armed while nothing is seeded;
        // without it, an empty selection turns it off (auto-off).
        if (state.active && !state.seedIds.size && getSetting("autoOff")
            && !getSetting("hoverMode")) {
            state.active = false;
            updateIndicator();
        }
        state.overrideActive = state.frameReveal && state.seedIds.size > 0;
    }
}

// Out-of-focus dimming is on only while the spotlight (or the hidden-links
// override) is showing a seeded focus set and the opacity setting asks for
// it.
function dimmingActive() {
    return (state.active || state.overrideActive) && state.seedIds.size > 0
        && state.frameNodeAlpha < 1;
}

// Single source of truth for node dimming: the multiplier to apply to a
// node's alpha, 1 when it must be left untouched.
function nodeDimFactor(node) {
    if (!dimmingActive() || !node || isNodeKept(node)) return 1;
    return Math.max(state.frameNodeAlpha, 0.02);
}

// A group follows the nodes it holds: it stays lit as long as one kept node
// sits in it, and dims with the rest otherwise. Membership uses the same
// rule as the canvas itself (LGraphGroup.recomputeInsideNodes): the node's
// bounding centre inside the group's bounds — computed here instead of read
// from group._nodes, which is only refreshed when groups move.
function groupDimFactor(group) {
    if (!dimmingActive() || !group) return 1;
    const bounds = group._bounding ?? group.boundingRect;
    if (!bounds) return 1;
    const [gx, gy, gw, gh] = bounds;
    for (const node of state.keptNodes) {
        const rect = node.boundingRect;
        const x = rect ? rect[0] + rect[2] * 0.5 : node.pos?.[0];
        const y = rect ? rect[1] + rect[3] * 0.5 : node.pos?.[1];
        if (x == null || y == null) continue;
        if (x >= gx && x <= gx + gw && y >= gy && y <= gy + gh) return 1;
    }
    return Math.max(state.frameNodeAlpha, 0.02);
}

// LGraphGroup is not reachable from an extension, so its draw() is wrapped
// through a live group the first time one is rendered. Both alphas the group
// paints with come from canvas.editor_alpha, so scaling that around the call
// dims the whole group — title bar, body fill, outline and label alike.
function patchGroupDraw(group) {
    const proto = group && Object.getPrototypeOf(group);
    if (!proto || patchedGroupProtos.has(proto)
        || typeof proto.draw !== "function") {
        return;
    }
    patchedGroupProtos.add(proto);
    const origDraw = proto.draw;
    proto.draw = function (canvas, ...rest) {
        const factor = groupDimFactor(this);
        if (factor >= 1 || !canvas) return origDraw.apply(this, arguments);
        const prevAlpha = canvas.editor_alpha;
        canvas.editor_alpha = prevAlpha * factor;
        try {
            return origDraw.apply(this, arguments);
        } finally {
            canvas.editor_alpha = prevAlpha;
        }
    };
}

export function patchCanvas() {
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
        prepareFrame(this);
        // Hidden-links override: restore the last non-hidden render mode for
        // this single call so the original draws, then hide again — links
        // the spotlight skips are never rendered, so they stay both
        // invisible and non-interactive. Empty seed set while hidden: fall
        // through, the original returns early and the graph stays exactly
        // as the button left it.
        if (state.frameReveal && state.seedIds.size) {
            this.links_render_mode = state.lastVisibleRenderMode;
            try {
                return origDrawConnections.apply(this, args);
            } finally {
                this.links_render_mode = HIDDEN_LINK;
            }
        }
        return origDrawConnections.apply(this, args);
    };

    const origRenderSegments = proto._renderAllLinkSegments;
    proto._renderAllLinkSegments = function (ctx, link, ...rest) {
        // Empty seed set without auto-off: never blind the whole graph.
        if ((!state.active && !state.overrideActive) || !state.seedIds.size
            || !link) {
            return origRenderSegments.apply(this, arguments);
        }
        if (isLinkFocused(link)) {
            const widthMult = state.frameFocusWidth;
            const glow = state.frameFocusGlow;
            if (widthMult <= 1 && glow <= 0) {
                return origRenderSegments.apply(this, arguments);
            }
            // renderLink() rebuilds its render context per call from
            // this.connections_width, so a scoped bump is picked up
            // immediately; both overrides are restored in finally.
            const prevWidth = this.connections_width;
            const prevShadowColor = ctx.shadowColor;
            const prevShadowBlur = ctx.shadowBlur;
            if (widthMult > 1) this.connections_width = prevWidth * widthMult;
            if (glow > 0) {
                ctx.shadowColor = FOCUS_GLOW_COLOR;
                ctx.shadowBlur = glow;
            }
            try {
                return origRenderSegments.apply(this, arguments);
            } finally {
                this.connections_width = prevWidth;
                ctx.shadowColor = prevShadowColor;
                ctx.shadowBlur = prevShadowBlur;
            }
        }
        if (!(state.frameDimAlpha > 0)) return undefined; // link hidden
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * state.frameDimAlpha;
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
        const factor = nodeDimFactor(node);
        if (factor >= 1) return origDrawNode.apply(this, arguments);
        const prevAlpha = this.editor_alpha;
        this.editor_alpha = prevAlpha * factor;
        try {
            return origDrawNode.apply(this, arguments);
        } finally {
            this.editor_alpha = prevAlpha;
        }
    };

    // Bypassed, muted and ghost nodes are drawn with a fixed alpha that
    // ignores editor_alpha entirely (0.2 / 0.4 / 0.3), so the wrapper above
    // has no effect on them — nor on any node's widgets, which are handed
    // this same alpha. Fold the dim factor into it here instead.
    if (typeof proto.getNodeModeAlpha === "function") {
        const origGetNodeModeAlpha = proto.getNodeModeAlpha;
        proto.getNodeModeAlpha = function (node) {
            const alpha = origGetNodeModeAlpha.apply(this, arguments);
            const factor = nodeDimFactor(node);
            // A node on the regular path gets editor_alpha back, which the
            // drawNode wrapper has already scaled — dimming it again here
            // would square the factor. Mirrors the original's own branch
            // condition: comparing alpha to editor_alpha instead would
            // silently skip the dim whenever a fixed constant collides
            // with the scaled editor_alpha (e.g. NodeAlpha 0.2 × bypass
            // 0.2). Mode values are frozen (serialized in workflows).
            const fixedModeAlpha = !!node?.flags?.ghost
                || node?.mode === 4 // BYPASS
                || node?.mode === 2; // NEVER (muted)
            if (factor >= 1 || !fixedModeAlpha) return alpha;
            return alpha * factor;
        };
    } else {
        console.warn(
            `${EXT_NAME}: LGraphCanvas.getNodeModeAlpha missing (frontend `
            + `update?), bypassed/muted nodes will not dim`,
        );
    }

    // Groups draw themselves, so the only way in is their own draw(): grab
    // a live one on the way past and wrap its prototype (once). drawGroups
    // runs before drawConnections in drawBackCanvas, hence the
    // prepareFrame call here too.
    if (typeof proto.drawGroups === "function") {
        const origDrawGroups = proto.drawGroups;
        proto.drawGroups = function (...args) {
            prepareFrame(this);
            const groups = this.graph?._groups;
            if (groups?.length) patchGroupDraw(groups[0]);
            return origDrawGroups.apply(this, args);
        };
    } else {
        console.warn(
            `${EXT_NAME}: LGraphCanvas.drawGroups missing (frontend `
            + `update?), groups will not dim`,
        );
    }

    // Redraw (background + foreground: links may be drawn on top with
    // links_ontop) as soon as the selection changes while the spotlight is
    // active — avoids a stale visual state when only the foreground is dirty.
    // Deliberately patched on the INSTANCE: onSelectionChange is a class
    // field of LGraphCanvas (an instance property initialized to undefined),
    // so a prototype patch would be shadowed and never called.
    const origOnSelectionChange = canvas.onSelectionChange;
    canvas.onSelectionChange = function (...args) {
        const r = origOnSelectionChange?.apply(this, args);
        if (state.active
            || (this.links_render_mode === HIDDEN_LINK
                && getSetting("revealHidden"))) {
            this.setDirty(true, true);
        }
        return r;
    };

    // Hover tracking lives on the window, capture phase: in Vue nodes mode
    // the DOM-rendered nodes swallow pointer events before the canvas sees
    // them, and the front canvas is not reliably redrawn — so neither
    // canvas.node_over nor a render-loop hook can drive hover mode there.
    window.addEventListener("pointermove", onPointerMove, {
        capture: true,
        passive: true,
    });

    return true;
}
