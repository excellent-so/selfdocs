// selfdocs — merge fresh auto-blocks into stored blocks, preserving user-authored
// blocks by anchor. THE load-bearing invariant of the whole tool: your annotations
// survive every regeneration.
//
// Every function here is PURE: it takes the current block array and returns a new
// one. Storage is a JSON file (see store.mjs), so a change is "compute the whole
// array, then write it once".
//
// Block shape (one object per block in `.selfdocs/docs/<type>.json`):
//   { id, position, origin: "auto"|"user", block_type, content,
//     anchor: string|null, after_anchor: string|null, detached: 0|1,
//     created_at, updated_at }

import { newId } from "./lib.mjs";

/**
 * Merge a freshly parsed list of auto-blocks into the stored blocks.
 *
 * Auto-blocks match by anchor: same anchor → update content (keep id); new anchor →
 * insert; missing anchor → delete. User blocks survive: if their `after_anchor` still
 * exists in the new auto set they're re-threaded adjacent to it; otherwise they're
 * marked `detached` and float to the bottom until the anchor comes back.
 *
 * @param {object[]} existing        the stored block array
 * @param {{ anchor: string, block_type: string, content: string }[]} newAutoBlocks
 * @param {string}   [now]           ISO timestamp (injectable for deterministic tests)
 * @returns {{ blocks: object[], report: { inserted, updated, deleted, detached, reattached } }}
 */
export function mergeBlocks(existing, newAutoBlocks, now = new Date().toISOString()) {
  const existingAuto = new Map();
  const existingUser = [];
  for (const b of existing) {
    if (b.origin === "auto" && b.anchor) existingAuto.set(b.anchor, b);
    else if (b.origin === "user") existingUser.push(b);
  }

  const newAnchors = new Set(newAutoBlocks.map((b) => b.anchor));
  let inserted = 0, updated = 0, deleted = 0, detached = 0, reattached = 0;

  // 1) Build the new auto-block objects, preserving id + created_at on a match.
  const autoByAnchor = new Map();
  for (const nb of newAutoBlocks) {
    const ex = existingAuto.get(nb.anchor);
    if (ex) {
      autoByAnchor.set(nb.anchor, { ...ex, block_type: nb.block_type, content: nb.content, updated_at: now });
      updated++;
    } else {
      autoByAnchor.set(nb.anchor, {
        id: newId(),
        position: 0,
        origin: "auto",
        block_type: nb.block_type,
        content: nb.content,
        anchor: nb.anchor,
        after_anchor: null,
        detached: 0,
        created_at: now,
        updated_at: now,
      });
      inserted++;
    }
  }
  // 2) Count deletions (auto anchors that vanished).
  for (const anchor of existingAuto.keys()) if (!newAnchors.has(anchor)) deleted++;

  // 3) Reconcile user blocks: detach if the after_anchor is gone, reattach if back.
  const users = existingUser.map((u) => ({ ...u }));
  for (const u of users) {
    const anchorStillExists = u.after_anchor === null ? true : newAnchors.has(u.after_anchor);
    const wasDetached = u.detached === 1;
    if (!anchorStillExists && !wasDetached) {
      u.detached = 1;
      u.updated_at = now;
      detached++;
    } else if (anchorStillExists && wasDetached) {
      u.detached = 0;
      u.updated_at = now;
      reattached++;
    }
  }

  // 4) Recompute positions:
  //    a. top-pinned user blocks (after_anchor=null, not detached)
  //    b. each new auto-block, then user blocks pinned to it (not detached)
  //    c. detached user blocks (preserve relative order, pushed to the end)
  const userByAnchor = new Map();
  for (const u of users) {
    if (u.detached === 1) continue;
    const key = u.after_anchor;
    const arr = userByAnchor.get(key) ?? [];
    arr.push(u);
    userByAnchor.set(key, arr);
  }
  for (const arr of userByAnchor.values()) arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const out = [];
  let pos = 0;
  const push = (b) => {
    b.position = pos++;
    out.push(b);
  };

  for (const u of userByAnchor.get(null) ?? []) push(u);
  for (const nb of newAutoBlocks) {
    push(autoByAnchor.get(nb.anchor));
    for (const u of userByAnchor.get(nb.anchor) ?? []) push(u);
  }
  const detachedRows = users.filter((u) => u.detached === 1).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const d of detachedRows) push(d);

  return { blocks: out, report: { inserted, updated, deleted, detached, reattached } };
}

/**
 * Insert a new user block adjacent to `after_anchor` (or at the top when null),
 * then renumber positions.
 *
 * @returns {{ blocks: object[], block: object }}
 */
export function insertUserBlock(blocks, { after_anchor = null, content, block_type = "paragraph" }, now = new Date().toISOString()) {
  const newBlock = {
    id: newId(),
    position: 0,
    origin: "user",
    block_type,
    content,
    anchor: null,
    after_anchor: after_anchor ?? null,
    detached: 0,
    created_at: now,
    updated_at: now,
  };

  const rest = blocks
    .map((b) => ({ ...b }))
    .sort((a, b) => (a.detached ?? 0) - (b.detached ?? 0) || (a.position ?? 0) - (b.position ?? 0));

  let targetIndex;
  if (newBlock.after_anchor === null) {
    targetIndex = 0;
  } else {
    let lastMatch = -1;
    for (let i = 0; i < rest.length; i++) {
      const b = rest[i];
      if (b.detached) break; // detached blocks live at the end
      if (b.origin === "auto" && b.anchor === newBlock.after_anchor) lastMatch = i;
      if (b.origin === "user" && b.after_anchor === newBlock.after_anchor) lastMatch = i;
    }
    targetIndex = lastMatch === -1 ? rest.length : lastMatch + 1;
  }
  rest.splice(targetIndex, 0, newBlock);
  rest.forEach((b, i) => (b.position = i));
  return { blocks: rest, block: newBlock };
}

/** Edit a user block's content (auto blocks are read-only — they regenerate). */
export function updateUserBlock(blocks, id, content, now = new Date().toISOString()) {
  let block = null;
  const out = blocks.map((b) => {
    if (b.id === id && b.origin === "user") {
      block = { ...b, content, updated_at: now };
      return block;
    }
    return b;
  });
  return { blocks: out, block };
}

/** Delete a user block, then renumber positions. */
export function deleteBlock(blocks, id) {
  const before = blocks.length;
  const out = blocks.filter((b) => !(b.id === id && b.origin === "user"));
  out.forEach((b, i) => (b.position = i));
  return { blocks: out, removed: out.length !== before };
}
