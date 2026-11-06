// selfdocs — the line-by-line markdown validator + autoRepair. Each rule traces to a
// render bug the block renderer can't recover from (unbalanced fences, a doc wrapped
// in a fence, a table with no alignment row, extra H1s, stray separators).

const REQUIRED_SECTIONS = {
  architecture: ["System Overview", "Technology Stack", "System Components"],
  schema: ["Overview", "Tables"],
  api: ["Overview", "Endpoints"],
  "data-flow": ["Overview"],
  integrations: ["Overview", "External Services"],
};

/**
 * @param {string} markdown
 * @param {string} docType
 * @returns {{ valid: boolean, issues: { severity: "error"|"warning", rule: string, message: string, line?: number }[] }}
 */
export function validateArchDoc(markdown, docType) {
  const issues = [];
  const lines = markdown.split("\n");

  checkNoPreamble(lines, issues);
  checkHasH1(lines, issues);
  checkRequiredSections(lines, docType, issues);
  checkBalancedCodeFences(lines, issues);
  checkNoWrappingFence(lines, issues);
  checkNoStraySeparators(lines, issues);
  checkTablesWellFormed(lines, issues);
  checkBalancedInlineCode(lines, issues);
  checkHeadingNesting(lines, issues);

  return { valid: issues.every((i) => i.severity !== "error"), issues };
}

export function autoRepair(markdown) {
  let result = markdown;
  result = stripWrappingFence(result);
  result = stripPreamble(result);
  result = stripStraySeparators(result);
  result = repairMissingTableAlignmentRows(result);
  result = demoteExtraH1s(result);
  result = normalizeBlankLines(result);
  return result;
}

function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim().startsWith("```")) {
      mask[i] = true;
      inside = !inside;
      continue;
    }
    mask[i] = inside;
  }
  return mask;
}

function checkNoPreamble(lines, issues) {
  const inFence = fenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("# ")) return;
    issues.push({
      severity: "error",
      rule: "no-preamble",
      message: `First non-empty line must be an H1 heading, found: "${trimmed.slice(0, 60)}"`,
      line: i + 1,
    });
    return;
  }
}

function checkHasH1(lines, issues) {
  const inFence = fenceMask(lines);
  const h1Lines = lines
    .map((l, i) => ({ text: l, line: i + 1, fenced: inFence[i] ?? false }))
    .filter(({ text, fenced }) => !fenced && /^# /.test(text));

  if (h1Lines.length === 0) {
    issues.push({ severity: "error", rule: "has-h1", message: "Document must have exactly one H1 heading" });
  } else if (h1Lines.length > 1) {
    issues.push({ severity: "error", rule: "has-h1", message: `Document has ${h1Lines.length} H1 headings (expected 1)` });
  }
}

function checkRequiredSections(lines, docType, issues) {
  const required = REQUIRED_SECTIONS[docType];
  if (!required) return;

  const inFence = fenceMask(lines);
  const h2Headings = lines
    .filter((l, i) => !inFence[i] && /^## /.test(l))
    .map((l) => l.replace(/^## /, "").trim());

  for (const req of required) {
    const reqLower = req.toLowerCase();
    const found = h2Headings.some((h) => h.toLowerCase().includes(reqLower));
    if (!found) {
      issues.push({
        severity: "error",
        rule: "has-required-sections",
        message: `Missing required section: "${req}" (doc type: ${docType})`,
      });
    }
  }
}

function checkBalancedCodeFences(lines, issues) {
  let openLine = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("```")) {
      if (openLine === null) openLine = i + 1;
      else openLine = null;
    }
  }
  if (openLine !== null) {
    issues.push({
      severity: "error",
      rule: "balanced-code-fences",
      message: `Unclosed code fence opened at line ${openLine}`,
      line: openLine,
    });
  }
}

function checkNoWrappingFence(lines, issues) {
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx === -1) return;
  const firstLine = lines[firstIdx].trim();
  const lastLine = lines[lastIdx].trim();
  if (firstLine.startsWith("```") && lastLine === "```" && firstIdx !== lastIdx) {
    issues.push({
      severity: "error",
      rule: "no-wrapping-fence",
      message: "Entire output is wrapped in a code fence",
      line: firstIdx + 1,
    });
  }
}

function checkNoStraySeparators(lines, issues) {
  const inFence = fenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const line = lines[i];
    if (!/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length) {
      issues.push({ severity: "warning", rule: "stray-separator", message: "Horizontal rule at end of document", line: i + 1 });
      continue;
    }
    if (!/^#{1,6}\s/.test(lines[j])) {
      issues.push({
        severity: "warning",
        rule: "stray-separator",
        message: "Stray horizontal rule inside a section — section H2s already own their divider",
        line: i + 1,
      });
    }
  }
}

// A table's header is its first row; it must be followed by an alignment row. Rows after it (the
// alignment row and the body) are the same table, so they're never checked as headers themselves.
const ALIGNMENT_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
function isTableRow(line) {
  if (!line || !line.includes("|")) return false;
  const cells = line.split("|").map((c) => c.trim());
  return cells.length >= 3 && (cells[0] === "" || cells[cells.length - 1] === "");
}

function checkTablesWellFormed(lines, issues) {
  const inFence = fenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i] || !isTableRow(lines[i])) continue;
    if (i > 0 && !inFence[i - 1] && isTableRow(lines[i - 1])) continue;
    const sep = lines[i + 1];
    if (sep && !ALIGNMENT_ROW.test(sep)) {
      issues.push({
        severity: "warning",
        rule: "table-missing-alignment-row",
        message: "Table header row not followed by an alignment row (`|---|---|`)",
        line: i + 1,
      });
    }
  }
}

function checkBalancedInlineCode(lines, issues) {
  const inFence = fenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const stripped = lines[i].replace(/\\`/g, "");
    const count = (stripped.match(/`/g) ?? []).length;
    if (count % 2 === 1) {
      issues.push({ severity: "warning", rule: "balanced-inline-code", message: `Line has unbalanced inline-code backticks`, line: i + 1 });
    }
  }
}

function checkHeadingNesting(lines, issues) {
  const inFence = fenceMask(lines);
  let lastLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (!m) continue;
    const lvl = m[1].length;
    if (lastLevel === 0 && lvl !== 1) {
      issues.push({ severity: "warning", rule: "heading-nesting", message: `First heading is H${lvl}, expected H1`, line: i + 1 });
    } else if (lvl > lastLevel + 1) {
      issues.push({
        severity: "warning",
        rule: "heading-nesting",
        message: `Heading jumped from H${lastLevel} to H${lvl} — levels must increase one at a time`,
        line: i + 1,
      });
    }
    lastLevel = lvl;
  }
}

function stripWrappingFence(markdown) {
  const lines = markdown.split("\n");
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx === -1) return markdown;
  const firstLine = lines[firstIdx].trim();
  const lastLine = lines[lastIdx].trim();
  if (firstLine.startsWith("```") && lastLine === "```" && firstIdx !== lastIdx) {
    const inner = lines.slice(firstIdx + 1, lastIdx);
    return inner.join("\n").trim() + "\n";
  }
  return markdown;
}

function stripPreamble(markdown) {
  const lines = markdown.split("\n");
  const h1Idx = lines.findIndex((l) => /^# /.test(l));
  if (h1Idx <= 0) return markdown;
  const hasPreamble = lines.slice(0, h1Idx).some((l) => l.trim() !== "");
  if (!hasPreamble) return markdown;
  return lines.slice(h1Idx).join("\n");
}

function stripStraySeparators(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  let insideFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      insideFence = !insideFence;
      out.push(line);
      continue;
    }
    if (insideFence) {
      out.push(line);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && /^#{1,6}\s/.test(lines[j])) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function normalizeBlankLines(markdown) {
  return markdown.replace(/\n{3,}/g, "\n\n");
}

function demoteExtraH1s(markdown) {
  const lines = markdown.split("\n");
  let insideFence = false;
  let h1Count = 0;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    if (/^# /.test(line)) h1Count++;
  }
  if (h1Count <= 1) return markdown;

  const out = [];
  insideFence = false;
  let seenFirstH1 = false;
  let demote = 0;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      insideFence = !insideFence;
      out.push(line);
      continue;
    }
    if (insideFence) {
      out.push(line);
      continue;
    }
    const m = /^(#{1,6})(\s+.*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const hashes = m[1] ?? "";
    const rest = m[2] ?? "";
    const lvl = hashes.length;
    if (lvl === 1) {
      if (!seenFirstH1) {
        seenFirstH1 = true;
        demote = 0;
        out.push(line);
      } else {
        demote = 1;
        out.push("#".repeat(Math.min(lvl + demote, 6)) + rest);
      }
      continue;
    }
    if (demote > 0) out.push("#".repeat(Math.min(lvl + demote, 6)) + rest);
    else out.push(line);
  }
  return out.join("\n");
}

function repairMissingTableAlignmentRows(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  let insideFence = false;

  function cellCount(line) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length > 0 && cells[0] === "") cells.shift();
    if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    return cells.length;
  }
  function isAlignmentRow(line) {
    return line != null && ALIGNMENT_ROW.test(line);
  }
  function isCandidateHeader(line) {
    if (!line.includes("|")) return false;
    return cellCount(line) >= 2;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().startsWith("```")) {
      insideFence = !insideFence;
      out.push(line);
      continue;
    }
    if (insideFence) {
      out.push(line);
      continue;
    }
    out.push(line);

    if (!isCandidateHeader(line)) continue;
    // Only the table's FIRST row is a header — a row preceded by another table
    // row (or an alignment row) is body, and repairing after it would salt an
    // alignment row between every pair of data rows.
    const prev = lines[i - 1];
    if (prev != null && (isCandidateHeader(prev) || isAlignmentRow(prev))) continue;
    const next = lines[i + 1];
    if (next == null) continue;
    if (isAlignmentRow(next)) continue;
    if (!isCandidateHeader(next)) continue;
    if (cellCount(next) !== cellCount(line)) continue;
    const cols = cellCount(line);
    const align = "|" + " --- |".repeat(cols);
    out.push(align);
  }
  return out.join("\n");
}
