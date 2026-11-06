// selfdocs — markdown → anchored auto-blocks. Each block carries a stable anchor
// derived from the heading path, so a regenerated doc's blocks line up with the
// stored ones and user annotations stay attached (see block-merge.mjs).
//
// Block types: heading | paragraph | code | list | callout | table | rule.
//
// Anchor formats:
//   heading: "h1:doc", "h2:doc/foo", "h2:_/foo" — `_` is the placeholder for a
//            missing level. Collisions inside the same parent get -2, -3 suffixes.
//   body:    "body:doc/foo/1", "body:_/foo/1" — internal index per section.

/**
 * @param {string} markdown
 * @returns {{ anchor: string, block_type: string, content: string }[]}
 */
export function parseMarkdownToBlocks(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];

  const headingPath = [];
  const sectionContentCount = new Map();
  const headingAnchorCount = new Map();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      const level = (headingMatch[1] ?? "").length;
      const text = headingMatch[2] ?? "";
      const slug = slugify(text);

      if (headingPath.length > level - 1) headingPath.length = level - 1;
      while (headingPath.length < level - 1) headingPath.push("_");
      headingPath.push(slug);

      const anchorPath = headingPath.slice(0, level).join("/");
      sectionContentCount.set(anchorPath, 0);

      const base = `h${level}:${anchorPath}`;
      const seen = headingAnchorCount.get(base) ?? 0;
      const headingAnchor = seen === 0 ? base : `${base}-${seen + 1}`;
      headingAnchorCount.set(base, seen + 1);

      blocks.push({ anchor: headingAnchor, block_type: "heading", content: line });
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      pushBodyBlock(blocks, headingPath, sectionContentCount, "rule", "---");
      i++;
      continue;
    }

    // Code fence.
    if (/^```/.test(line)) {
      const fenceLines = [line];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        fenceLines.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) {
        fenceLines.push(lines[i] ?? "");
        i++;
      }
      pushBodyBlock(blocks, headingPath, sectionContentCount, "code", fenceLines.join("\n"));
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Table.
    if (isTableHeader(lines, i)) {
      const tableLines = [];
      while (
        i < lines.length &&
        (lines[i] ?? "").trim() !== "" &&
        !/^#{1,6}\s/.test(lines[i] ?? "")
      ) {
        tableLines.push(lines[i] ?? "");
        i++;
      }
      pushBodyBlock(blocks, headingPath, sectionContentCount, "table", tableLines.join("\n"));
      continue;
    }

    // Paragraph / list / callout.
    const paraLines = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "") break;
      if (/^#{1,6}\s/.test(l)) break;
      if (/^```/.test(l)) break;
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) break;
      if (paraLines.length === 0 && isTableHeader(lines, i)) break;
      paraLines.push(l);
      i++;
    }
    if (paraLines.length === 0) continue;

    let blockType = "paragraph";
    const firstLine = paraLines[0] ?? "";
    if (/^[-*+]\s/.test(firstLine) || /^\d+\.\s/.test(firstLine)) blockType = "list";
    else if (/^>\s?/.test(firstLine)) blockType = "callout";

    pushBodyBlock(blocks, headingPath, sectionContentCount, blockType, paraLines.join("\n"));
  }

  return blocks;
}

function isTableHeader(lines, i) {
  const header = lines[i];
  const sep = lines[i + 1];
  if (!header || !sep) return false;
  if (!header.includes("|")) return false;
  if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(sep)) return false;
  return true;
}

function pushBodyBlock(blocks, headingPath, counts, blockType, content) {
  const sectionKey = headingPath.join("/");
  const idx = (counts.get(sectionKey) ?? 0) + 1;
  counts.set(sectionKey, idx);
  blocks.push({ anchor: `body:${sectionKey}/${idx}`, block_type: blockType, content });
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
}
