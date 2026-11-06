// selfdocs — scan + detection → a Manifest. Extra ignore patterns from the config go
// on top of the built-in defaults and the repo's .gitignore.

import { createIgnore } from "./ignore.mjs";
import { scanDirectory } from "./scanner.mjs";
import {
  detectProjectType,
  detectFramework,
  detectTestFramework,
  detectCI,
  detectPackageManager,
} from "./root.mjs";

const MANIFEST_VERSION = "1.0";

/**
 * @param {string}   projectRoot
 * @param {string[]} [extraIgnore]  additional ignore patterns from config
 * @returns {object} the Manifest
 */
export function generateManifest(projectRoot, extraIgnore = []) {
  const ig = createIgnore(projectRoot, extraIgnore);
  const projectType = detectProjectType(projectRoot);
  const scanResult = scanDirectory(projectRoot, { ignore: ig });

  const markers = {
    package_manager: detectPackageManager(projectRoot, projectType),
    framework: detectFramework(projectRoot, projectType),
    test_framework: detectTestFramework(projectRoot, projectType),
    ci: detectCI(projectRoot),
  };

  return {
    version: MANIFEST_VERSION,
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    project_type: projectType,
    stats: {
      total_files: scanResult.files.length,
      total_dirs: scanResult.dirs.size,
      total_size_bytes: scanResult.totalSize,
    },
    markers,
    files: scanResult.files,
  };
}
