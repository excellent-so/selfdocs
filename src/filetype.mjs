// selfdocs — file-type classification (`detectFileType`): test, config, docs, binary,
// data, source or other, from the path alone. The scanner tags every file with it.

/** @returns {"test"|"config"|"docs"|"binary"|"data"|"source"|"other"} */
export function detectFileType(relativePath) {
  const path = relativePath.toLowerCase();

  if (
    path.includes("test") ||
    path.includes("spec") ||
    path.includes("__tests__") ||
    path.endsWith(".test.ts") ||
    path.endsWith(".test.js") ||
    path.endsWith(".spec.ts") ||
    path.endsWith(".spec.js") ||
    path.endsWith("_test.go") ||
    path.endsWith("_test.py")
  ) {
    return "test";
  }

  if (
    path.includes("config") ||
    path.endsWith(".json") ||
    path.endsWith(".yaml") ||
    path.endsWith(".yml") ||
    path.endsWith(".toml") ||
    path.endsWith(".ini") ||
    path.endsWith(".env") ||
    path.endsWith(".env.local") ||
    path.endsWith(".env.example") ||
    path === "dockerfile" ||
    path.endsWith("dockerfile") ||
    path === ".gitignore" ||
    path === ".prettierrc" ||
    path === ".eslintrc"
  ) {
    return "config";
  }

  if (
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path.endsWith(".rst") ||
    path.endsWith(".txt") ||
    path.includes("docs/") ||
    path.includes("documentation/")
  ) {
    return "docs";
  }

  const binaryExtensions = [
    ".exe", ".dll", ".so", ".dylib", ".png", ".jpg", ".jpeg", ".gif", ".ico",
    ".webp", ".svg", ".pdf", ".zip", ".tar", ".gz", ".rar", ".woff", ".woff2",
    ".ttf", ".eot", ".mp3", ".mp4", ".wav", ".avi", ".mov", ".sqlite", ".db",
  ];
  if (binaryExtensions.some((ext) => path.endsWith(ext))) return "binary";

  if (
    path.endsWith(".csv") ||
    path.endsWith(".sql") ||
    path.includes("fixtures/") ||
    path.includes("seeds/")
  ) {
    return "data";
  }

  const sourceExtensions = [
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".go", ".rs",
    ".java", ".kt", ".scala", ".rb", ".php", ".cs", ".fs", ".c", ".cpp", ".cc",
    ".h", ".hpp", ".swift", ".vue", ".svelte", ".css", ".scss", ".sass",
    ".less", ".html", ".htm",
  ];
  if (sourceExtensions.some((ext) => path.endsWith(ext))) return "source";

  return "other";
}
