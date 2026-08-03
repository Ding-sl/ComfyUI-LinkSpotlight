// ComfyUI-LinkSpotlight — focus computation.
//
// Once per frame, walks the graph from the current seeds (selected nodes,
// nodes inside selected groups, or the hovered node in hover mode) and fills
// state.keptNodeIds / state.focusLinkIds. The traversal is a 0-1 BFS bounded
// by the depth setting and constrained by the direction setting; Reroute
// nodes are traversed as pass-throughs (they never consume a hop).

import { FULL_TRACE, getNumericSetting, getSetting, state } from "./state.js";

function getLink(graph, linkId) {
    return graph._links?.get?.(linkId) ?? graph.links?.[linkId];
}

// Duck-typed LGraphGroup detection: LGraphGroup is not importable from
// /scripts/app.js, and instanceof would tie us to a litegraph build anyway.
export function isGroupItem(item) {
    return !!item
        && Array.isArray(item._nodes)
        && typeof item.recomputeInsideNodes === "function";
}

function isPassThrough(node) {
    return node?.type === "Reroute";
}

// Seeds: selected nodes, plus every node inside a selected group, plus (in
// hover mode, when nothing else is seeded) the node under the cursor.
// Fills state.seedIds and returns the seed node objects.
function collectSeeds(canvas) {
    const seeds = [];
    state.seedIds.clear();
    const addSeed = (node) => {
        if (!node) return;
        const id = String(node.id);
        if (state.seedIds.has(id)) return;
        state.seedIds.add(id);
        seeds.push(node);
    };
    const selected = canvas.selected_nodes ?? {};
    for (const key in selected) addSeed(selected[key]);
    canvas.selectedItems?.forEach?.((item) => {
        if (!isGroupItem(item)) return;
        item.recomputeInsideNodes();
        for (const node of item._nodes) addSeed(node);
    });
    // Hover seed: our own pointermove hit-test (state.hoverNode, render.js)
    // — canvas.node_over is only a fallback, it never updates in Vue nodes
    // mode.
    if (!seeds.length && getSetting("hoverMode")) {
        addSeed(state.hoverNode ?? canvas.node_over);
    }
    return seeds;
}

// Visits a neighbor reached through a link. Virtual endpoints (subgraph IO
// slots use negative ids and have no node object) are kept but not expanded.
// Pass-through nodes re-enter the deque at the SAME depth, from the front,
// so BFS depths stay monotonic (0-1 BFS).
function enqueue(graph, queue, rawId, depth) {
    const id = String(rawId);
    if (state.keptNodeIds.has(id)) return;
    state.keptNodeIds.add(id);
    const node = graph.getNodeById?.(rawId);
    if (!node) return;
    state.keptNodes.push(node);
    if (isPassThrough(node)) queue.unshift({ node, depth });
    else queue.push({ node, depth: depth + 1 });
}

function traverse(graph, seeds, maxDepth, goUpstream, goDownstream) {
    const queue = seeds.map((node) => ({ node, depth: 0 }));
    while (queue.length) {
        const { node, depth } = queue.shift();
        if (depth >= maxDepth) continue; // kept, but its own links stay out
        if (goUpstream) {
            for (const input of node.inputs ?? []) {
                if (input?.link == null) continue;
                const link = getLink(graph, input.link);
                if (!link) continue;
                state.focusLinkIds.add(String(link.id));
                enqueue(graph, queue, link.origin_id, depth);
            }
        }
        if (goDownstream) {
            for (const output of node.outputs ?? []) {
                for (const linkId of output?.links ?? []) {
                    const link = getLink(graph, linkId);
                    if (!link) continue;
                    state.focusLinkIds.add(String(link.id));
                    enqueue(graph, queue, link.target_id, depth);
                }
            }
        }
    }
}

export function computeFocus(canvas) {
    const seeds = collectSeeds(canvas);
    state.keptNodeIds.clear();
    state.focusLinkIds.clear();
    state.keptNodes.length = 0;
    const graph = canvas.graph;
    if (!graph || !seeds.length) return;
    for (const node of seeds) {
        state.keptNodeIds.add(String(node.id));
        state.keptNodes.push(node);
    }
    const depthSetting = getNumericSetting("depth");
    const maxDepth =
        depthSetting === FULL_TRACE ? Infinity : Math.max(1, depthSetting);
    const direction = getSetting("direction");
    traverse(
        graph,
        seeds,
        maxDepth,
        direction !== "downstream",
        direction !== "upstream",
    );
}

export function isLinkFocused(link) {
    if (state.focusLinkIds.has(String(link.id))) return true;
    // Floating links (one dangling end) are not reachable through the
    // inputs/outputs walk — fall back to the attached node, like v1.0 did.
    const isFloating = link.origin_id === -1 || link.target_id === -1;
    if (!isFloating) return false;
    return state.keptNodeIds.has(String(link.origin_id))
        || state.keptNodeIds.has(String(link.target_id));
}

export function isNodeKept(node) {
    return state.keptNodeIds.has(String(node.id));
}
