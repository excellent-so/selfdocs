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
        if (deps["@nestjs/core"]) return "nest";
        if (deps["express"]) return "express";
        if (deps["fastify"]) return "fastify";
        if (deps["hono"]) return "hono";
        if (deps["koa"]) return "koa";
      }
    } catch {
      // ignore
    }
  }
  if (projectType === "python") {
    // Whichever of these the project declares its dependencies in.
    const declared = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"]
      .map((f) => readText(join(root, f)).toLowerCase())
      .join("\n");
    for (const fw of ["django", "fastapi", "flask"]) if (new RegExp(`\\b${fw}\\b`).test(declared)) return fw;
  }
  if (projectType === "go") {
    const gomod = readText(join(root, "go.mod"));
    const GO_FRAMEWORKS = [
      ["github.com/gin-gonic/gin", "gin"],
      ["github.com/labstack/echo", "echo"],
      ["github.com/gofiber/fiber", "fiber"],
      ["github.com/go-chi/chi", "chi"],
      ["github.com/gorilla/mux", "gorilla"],
    ];
    for (const [mod, name] of GO_FRAMEWORKS) if (gomod.includes(mod)) return name;
  }
  return null;
}

function readText(file) {
  try {
    return existsSync(file) ? readFileSync(file, "utf-8") : "";
  } catch {
    return "";
  }
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
