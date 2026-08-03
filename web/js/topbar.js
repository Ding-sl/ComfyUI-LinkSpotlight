// ComfyUI-LinkSpotlight — topbar button (indicator + toggle).
//
// Same injection technique as classic topbar extensions: a ComfyButton in a
// ComfyButtonGroup inserted before the settings group. The button doubles as
// a persistent, always-visible activity indicator — highlighted gold with a
// filled eye while the spotlight is active. Pure module: no side effects on
// import; link_spotlight.js calls injectTopbarButton() from setup().

import { app } from "../../../scripts/app.js";
import { EXT_NAME, state } from "./state.js";

let button = null;

export function updateTopbarButton() {
    const el = button?.element;
    if (!el) return;
    const active = state.active;
    el.style.color = active ? "#ffd54f" : "";
    el.style.backgroundColor = active ? "rgba(255, 213, 79, 0.15)" : "";
    const icon = el.querySelector(".mdi");
    if (icon) {
        icon.classList.toggle("mdi-eye-outline", !active);
        icon.classList.toggle("mdi-eye", active);
    }
}

export async function injectTopbarButton(onToggle) {
    if (button) return;
    try {
        const { ComfyButton } = await import(
            "../../../scripts/ui/components/button.js"
        );
        const { ComfyButtonGroup } = await import(
            "../../../scripts/ui/components/buttonGroup.js"
        );
        button = new ComfyButton({
            icon: "eye-outline",
            content: "Spotlight",
            tooltip:
                "Link Spotlight (Alt+H): only the selected node's links stay "
                + "visible. Highlighted while active.",
            action: onToggle,
            classList: "comfyui-button comfyui-menu-mobile-collapse",
        });
        const group = new ComfyButtonGroup(button);
        app.menu?.settingsGroup?.element?.before(group.element);
        updateTopbarButton();
    } catch (err) {
        // Topbar unavailable (legacy menu?): shortcut, toolbox and menus
        // keep working without the button.
        button = null;
        console.warn(`${EXT_NAME}: topbar button not injected`, err);
    }
}
