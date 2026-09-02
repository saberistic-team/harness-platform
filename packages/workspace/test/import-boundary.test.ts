import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FORBIDDEN_HOST_MODULES = new Set([
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "fs",
  "fs/promises",
  "child_process",
]);

interface ForbiddenImport {
  file: string;
  line: number;
  module: string;
}

function unwrapModuleExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function importedModule(node: ts.Node): ts.StringLiteralLike | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      ? node.moduleSpecifier
      : undefined;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression;
  }
  if (ts.isImportTypeNode(node)) {
    const argument = node.argument;
    return ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)
      ? argument.literal
      : undefined;
  }
  if (ts.isCallExpression(node) && node.arguments.length >= 1) {
    const expression = unwrapModuleExpression(node.expression);
    const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(expression) && expression.text === "require";
    const rawArgument = node.arguments[0];
    const argument = rawArgument === undefined
      ? undefined
      : unwrapModuleExpression(rawArgument);
    if ((isDynamicImport || isRequire) && argument && ts.isStringLiteralLike(argument)) {
      return argument;
    }
  }
  return undefined;
}

function findForbiddenImports(source: string, file: string): ForbiddenImport[] {
  const extension = extname(file);
  const scriptKind = extension === ".tsx"
    ? ts.ScriptKind.TSX
    : extension === ".jsx"
      ? ts.ScriptKind.JSX
      : [".js", ".mjs", ".cjs"].includes(extension)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const findings: ForbiddenImport[] = [];

  function visit(node: ts.Node): void {
    const module = importedModule(node);
    if (module && FORBIDDEN_HOST_MODULES.has(module.text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(module.getStart(sourceFile));
      findings.push({ file, line: line + 1, module: module.text });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

async function listTypeScriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`source boundary refuses symbolic link: ${path}`);
    }
    if (entry.isDirectory()) return listTypeScriptSources(path);
    return entry.isFile() && [
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
    ].includes(extname(path))
      ? [path]
      : [];
  }));
  return files.flat().sort();
}

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("workspace host import boundary", () => {
  it("detects known-bad static, re-exported, type, dynamic, and require imports", () => {
    const fixtures: ReadonlyArray<Readonly<{
      module: string;
      source: string;
    }>> = [
      { module: "node:fs", source: 'import * as fs from "node:fs";' },
      { module: "fs", source: 'import type { Stats } from "fs";' },
      { module: "node:fs/promises", source: 'export { readFile } from "node:fs/promises";' },
      { module: "fs/promises", source: 'type Read = import("fs/promises").readFile;' },
      { module: "node:child_process", source: 'void import("node:child_process");' },
      {
        module: "node:fs",
        source: 'void import("node:fs", { with: { type: "javascript" } });',
      },
      { module: "node:fs", source: 'void import(("node:fs"));' },
      { module: "node:fs", source: 'void import("node:fs" as string);' },
      { module: "fs", source: 'const filesystem = require(("fs"));' },
      { module: "node:fs", source: 'const filesystem = require("node:fs", null);' },
      { module: "fs", source: 'const filesystem = (require)("fs");' },
      { module: "child_process", source: 'const process = require("child_process");' },
    ];

    for (const fixture of fixtures) {
      expect(findForbiddenImports(fixture.source, "known-bad.ts")).toEqual([
        { file: "known-bad.ts", line: 1, module: fixture.module },
      ]);
    }
  });

  it("does not flag allowed imports or ordinary string contents", () => {
    const source = [
      'import { resolve } from "node:path";',
      'const documentation = "node:fs";',
      'export { resolve };',
    ].join("\n");

    expect(findForbiddenImports(source, "allowed.ts")).toEqual([]);
  });

  it("checks JavaScript-family production sources too", () => {
    expect(findForbiddenImports(
      'export { readFile } from "node:fs/promises";',
      "known-bad.mjs",
    )).toEqual([{
      file: "known-bad.mjs",
      line: 1,
      module: "node:fs/promises",
    }]);
  });

  it("keeps kernel and model-facing tool source behind Workspace", async () => {
    const sourceDirectories = [
      resolve(repositoryRoot, "packages/kernel/src"),
      resolve(repositoryRoot, "packages/tools/src"),
    ];
    const files = (await Promise.all(
      sourceDirectories.map(listTypeScriptSources),
    )).flat().sort();
    const findings = (await Promise.all(files.map(async (file) =>
      findForbiddenImports(await readFile(file, "utf8"), file)
    ))).flat();

    expect(findings).toEqual([]);
  });
});
