// ComfyUI-LinkSpotlight — topbar button (indicator + toggle).
//
// The button is declared through the frontend's public `actionBarButtons`
// extension field (frontend ≥ 1.49): the topbar renders it first in its
// right-hand card, just before the Run bar. It doubles as a persistent,
// always-visible activity indicator — gold with a slashed eye while the
// spotlight is active.
//
// Constraints that shaped this module:
// - The frontend stores extension objects with markRaw(), so nothing declared
//   here is reactive. The active state is reflected by toggling a class and
//   the icon on the rendered element. Vue does not touch DOM attributes whose
//   bindings did not change, so the toggled classes survive re-renders; the
//   element is re-queried on every update rather than cached, so a re-mount
//   cannot strand a stale node either.
// - The legacy ComfyButton/ComfyButtonGroup route is kept only as a fallback
//   for frontends without an action bar, reached through window.comfyAPI:
//   importing the /scripts/ui/components/*.js shims makes the server log a
//   deprecation warning and they are slated for removal.
// - Pure module: no side effects on import. link_spotlight.js passes
//   actionBarButtons() to registerExtension and calls ensureTopbarButton()
//   from setup().

import { app } from "../../../scripts/app.js";
import { EXT_NAME, state } from "./state.js";

const BUTTON_CLASS = "linkspotlight-actionbar-button";
const ACTIVE_CLASS = "linkspotlight-active";
const STYLE_ID = "linkspotlight-actionbar-style";
// PrimeIcons: a full icon font, unlike the frontend's lucide classes, which
// are compiled on demand and only exist for the icons the frontend itself
// uses.
const ICON_IDLE = "pi-eye";
const ICON_ACTIVE = "pi-eye-slash";
const TOOLTIP =
    "Link Spotlight (Alt+H): only the selected node's links stay visible. "
    + "Highlighted while active.";
// The action bar is a Vue component that mounts on its own schedule relative
// to setup(), and its v-for is keyed by index: a later registration can
// re-purpose our DOM node for another extension's button. A MutationObserver
// therefore re-applies the active look on every DOM change (late mount,
// re-mount, reorder) and hands over from the legacy fallback the instant the
// native button exists. The fallback itself is only injected when no native
// button has shown up after this delay — skipped for frontends that report a
// version older than the one that introduced the action bar.
const LEGACY_FALLBACK_DELAY_MS = 3000;
const ACTION_BAR_MIN_FRONTEND = [1, 49];

let started = false;
let observer = null;
let legacy = null; // { button, group } from the legacy fallback, if used

/**
 * Descriptor for the `actionBarButtons` extension field.
 * @param {() => void} onToggle
 */
export function actionBarButtons(onToggle) {
    return [
        {
            icon: `pi ${ICON_IDLE}`,
            label: "Spotlight",
            tooltip: TOOLTIP,
            class: BUTTON_CLASS,
            onClick: onToggle,
        },
    ];
}

function nativeButtonElement() {
    return document.querySelector(
        `[data-testid="action-bar-buttons"] .${BUTTON_CLASS}`,
    );
}

function ensureActiveStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // !important: the button's own variant classes set color/background.
    style.textContent =
        `.${BUTTON_CLASS}.${ACTIVE_CLASS} {`
        + " color: #ffd54f !important;"
        + " background-color: rgba(255, 213, 79, 0.15) !important; }";
    document.head.appendChild(style);
}

function removeLegacyButton() {
    legacy?.group?.element?.remove();
    legacy = null;
}

function updateNativeButton(el, active) {
    el.classList.toggle(ACTIVE_CLASS, active);
    const icon = el.querySelector("i");
    if (icon) {
        icon.classList.toggle(ICON_IDLE, !active);
        icon.classList.toggle(ICON_ACTIVE, active);
    }
}

function updateLegacyButton(el, active) {
    el.style.color = active ? "#ffd54f" : "";
    el.style.backgroundColor = active ? "rgba(255, 213, 79, 0.15)" : "";
    const icon = el.querySelector(".mdi");
    if (icon) {
        icon.classList.toggle("mdi-eye-outline", !active);
        icon.classList.toggle("mdi-eye", active);
    }
}

// Refreshes the button's active look. Called by render.js updateIndicator()
// from every place the active state can change.
export function updateTopbarButton() {
    const active = state.active;
    const native = nativeButtonElement();
    if (native) {
        // A native button showing up after the fallback was injected means
        // the action bar simply mounted late: keep the native one only.
        if (legacy) removeLegacyButton();
        updateNativeButton(native, active);
        return;
    }
    const el = legacy?.button?.element;
    if (el) updateLegacyButton(el, active);
}

// Legacy frontends only: the classic ComfyButton in a ComfyButtonGroup before
// the settings group, taken from window.comfyAPI (no shim import).
function injectLegacyButton(onToggle) {
    const ComfyButton = window.comfyAPI?.button?.ComfyButton;
    const ComfyButtonGroup = window.comfyAPI?.buttonGroup?.ComfyButtonGroup;
    const anchor = app.menu?.settingsGroup?.element;
    if (typeof ComfyButton !== "function"
        || typeof ComfyButtonGroup !== "function" || !anchor) {
        // Shortcut, toolbox and menus keep working without the button.
        console.info(`${EXT_NAME}: no action bar and no legacy topbar, `
            + "topbar button skipped");
        return;
    }
    try {
        const button = new ComfyButton({
            icon: "eye-outline",
            content: "Spotlight",
            tooltip: TOOLTIP,
            action: onToggle,
            classList: "comfyui-button comfyui-menu-mobile-collapse",
        });
        const group = new ComfyButtonGroup(button);
        anchor.before(group.element);
        legacy = { button, group };
        updateTopbarButton();
    } catch (err) {
        legacy = null;
        console.warn(`${EXT_NAME}: legacy topbar button not injected`, err);
    }
}

// True when the frontend announces a version that predates the action bar,
// false when it is recent enough or unknown (then the DOM decides).
function frontendPredatesActionBar() {
    const raw = window.__COMFYUI_FRONTEND_VERSION__;
    const match = typeof raw === "string" && /^(\d+)\.(\d+)/.exec(raw);
    if (!match) return false;
    const [major, minor] = [Number(match[1]), Number(match[2])];
    const [minMajor, minMinor] = ACTION_BAR_MIN_FRONTEND;
    return major < minMajor || (major === minMajor && minor < minMinor);
}

// Re-applies the active look whenever the DOM changes. Mutations only come
// from DOM-rendered UI (the graph itself is a canvas), and each callback is
// one querySelector plus class toggles that are no-ops when nothing changed,
// so this stays cheap and cannot loop on its own writes.
function observeDom() {
    if (observer || typeof MutationObserver !== "function") return;
    observer = new MutationObserver(() => updateTopbarButton());
    observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Makes sure a topbar button exists: the native action-bar one once it has
 * mounted, otherwise the legacy fallback. Idempotent: later calls are no-ops.
 * @param {() => void} onToggle
 */
export function ensureTopbarButton(onToggle) {
    if (started) return;
    started = true;
    ensureActiveStyle();
    observeDom();
    if (nativeButtonElement()) {
        updateTopbarButton();
        return;
    }
    if (frontendPredatesActionBar()) {
        injectLegacyButton(onToggle);
        return;
    }
    setTimeout(() => {
        if (!nativeButtonElement()) injectLegacyButton(onToggle);
    }, LEGACY_FALLBACK_DELAY_MS);
}
