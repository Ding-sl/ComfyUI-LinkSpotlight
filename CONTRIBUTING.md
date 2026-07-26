# Contributing to ComfyUI-LinkSpotlight

Thanks for your interest! This is a small, focused, frontend-only extension —
contributions are welcome as long as they keep it that way.

## Development setup

No build step, no dependencies:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ding-sl/ComfyUI-LinkSpotlight
```

1. Edit `web/js/link_spotlight.js`.
2. Hard-refresh the ComfyUI browser tab (Ctrl+F5). No server restart needed
   for JS-only changes.
3. Check the browser console for errors prefixed with `LinkSpotlight`.

## Architecture in one minute

The extension wraps three `LGraphCanvas` prototype methods:

- `drawConnections` — recomputes the focus set (selected nodes + neighbors)
  and caches the alpha settings **once per frame**;
- `_renderAllLinkSegments` — per-link decision: draw, dim, or skip;
- `drawNode` — optional dimming of out-of-focus nodes via `editor_alpha`.

`onSelectionChange` is chained on the canvas **instance** (it is a class
field, so a prototype patch would be shadowed). See the header comment of
`link_spotlight.js` for the full rationale.

## Ground rules

These are the invariants every PR must preserve:

- **Never mutate the graph or workflow state.** No link/node property writes,
  ever — nothing may leak into the serialized JSON.
- **No settings-store reads in render hot paths.** Read settings once per
  frame in `drawConnections` and cache them in module vars.
- **Always restore canvas state.** Any `ctx.globalAlpha` / `editor_alpha`
  change must be reverted in a `finally` block.
- **Wrappers chain, never replace.** Always call the original method; other
  extensions patch the same internals.
- **Degrade cleanly.** New internal-API usage must be guarded by `typeof`
  checks in `patchCanvas`, with a `console.error` and full self-disable on
  mismatch. Breaking the canvas is never acceptable.
- **Zero dependencies, zero nodes.** Vanilla ES module only.

## Style

- 4-space indentation, vanilla JavaScript (no TypeScript, no build).
- Comments explain *constraints* (why something must be done this way), not
  what the next line does.
- `console.error`/`console.warn` only — no `console.log` in committed code.

## Manual test checklist

Run through this before opening a PR (there is no automated test harness —
the code is 100% canvas rendering):

- [ ] Alt+H toggles on/off with a node selected; toast shown when nothing is
  selected.
- [ ] Spotlight follows the selection live (click several nodes in a row).
- [ ] Multi-selection shows the union of links.
- [ ] Depth 1 vs 2 behave as documented.
- [ ] Link opacity 0 (hidden) and 0.07 (dimmed) both render correctly.
- [ ] Node dimming setting works and restores fully on toggle off.
- [ ] Auto-off on selection clear; with auto-off disabled, empty selection
  renders the graph normally (never all-hidden).
- [ ] Settings changes apply live while the spotlight is active.
- [ ] Works inside a subgraph and with reroutes on links.
- [ ] No console errors on load with the latest ComfyUI frontend.

## Commits and PRs

- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`.
- One logical change per PR; fill in the PR template (including the frontend
  version you tested against).

## Reporting a frontend breakage

ComfyUI frontend updates occasionally rename the internals this extension
wraps. If the console shows `LinkSpotlight: unexpected LGraphCanvas API`,
please open an issue with the dedicated *Frontend breakage* template — it is
usually a quick fix once the new method names are known.
