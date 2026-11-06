// selfdocs — project-root detection: project type, framework, test framework, CI,
// package manager, each read from the manifests, lockfiles and CI files in the repo root.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @returns {"node"|"python"|"go"|"rust"|"java"|"ruby"|"php"|"unknown"} */
export function detectProjectType(root) {
  const checks = [
    { files: ["package.json"], type: "node" },
    { files: ["pyproject.toml", "setup.py", "requirements.txt"], type: "python" },
    { files: ["go.mod"], type: "go" },
    { files: ["Cargo.toml"], type: "rust" },
    { files: ["pom.xml", "build.gradle", "build.gradle.kts"], type: "java" },
    { files: ["Gemfile"], type: "ruby" },
    { files: ["composer.json"], type: "php" },
  ];
  for (const check of checks) {
    for (const file of check.files) {
      if (existsSync(join(root, file))) return check.type;
    }
  }
  return "unknown";
}

export function detectFramework(root, projectType) {
  if (projectType === "node") {
    try {
      const pkgPath = join(root, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps["next"]) return "next";
        if (deps["nuxt"]) return "nuxt";
        if (deps["@angular/core"]) return "angular";
        if (deps["vue"]) return "vue";
        if (deps["react"]) return "react";
        if (deps["svelte"]) return "svelte";
        if (deps["express"]) return "express";
        if (deps["fastify"]) return "fastify";
        if (deps["hono"]) return "hono";
      }
    } catch {
      // ignore
    }
  }
  if (projectType === "python") {
    try {
      const pyprojectPath = join(root, "pyproject.toml");
      if (existsSync(pyprojectPath)) {
        const content = readFileSync(pyprojectPath, "utf-8");
        if (content.includes("django")) return "django";
        if (content.includes("fastapi")) return "fastapi";
        if (content.includes("flask")) return "flask";
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function detectTestFramework(root, projectType) {
  if (projectType === "node") {
    try {
      const pkgPath = join(root, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps["vitest"]) return "vitest";
        if (deps["jest"]) return "jest";
        if (deps["mocha"]) return "mocha";
        if (deps["ava"]) return "ava";
      }
    } catch {
      // ignore
    }
  }
  if (projectType === "python") {
    if (existsSync(join(root, "pytest.ini")) || existsSync(join(root, "conftest.py"))) {
      return "pytest";
    }
  }
  return null;
}

export function detectCI(root) {
  const ci = [];
  if (existsSync(join(root, ".github/workflows"))) ci.push("github-actions");
  if (existsSync(join(root, ".gitlab-ci.yml"))) ci.push("gitlab-ci");
  if (existsSync(join(root, ".circleci"))) ci.push("circleci");
  if (existsSync(join(root, "Jenkinsfile"))) ci.push("jenkins");
  if (existsSync(join(root, ".travis.yml"))) ci.push("travis");
  if (existsSync(join(root, "azure-pipelines.yml"))) ci.push("azure-pipelines");
  if (existsSync(join(root, "bitbucket-pipelines.yml"))) ci.push("bitbucket");
  return ci;
}

export function detectPackageManager(root, projectType) {
  if (projectType === "node") {
    if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(root, "yarn.lock"))) return "yarn";
    if (existsSync(join(root, "bun.lockb"))) return "bun";
    if (existsSync(join(root, "package-lock.json"))) return "npm";
    return "npm";
  }
  if (projectType === "python") {
    if (existsSync(join(root, "poetry.lock"))) return "poetry";
    if (existsSync(join(root, "Pipfile.lock"))) return "pipenv";
    if (existsSync(join(root, "uv.lock"))) return "uv";
    return "pip";
  }
  if (projectType === "rust") return "cargo";
  if (projectType === "go") return "go";
  if (projectType === "ruby") return "bundler";
  if (projectType === "php") return "composer";
  return null;
}
