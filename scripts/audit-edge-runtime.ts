import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SOURCE_EXTENSION_SET = new Set(SOURCE_EXTENSIONS);
const SKIPPED_DIRS = new Set([".git", ".next", "coverage", "dist", "node_modules"]);

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

export interface EdgeRuntimeViolation {
  entrypoint: string;
  importer: string;
  specifier: string;
  chain: string[];
}

interface ImportReference {
  specifier: string;
  index: number;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function relativeToRoot(root: string, filePath: string): string {
  return toPosixPath(path.relative(root, filePath));
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/(^|[^:])\/\/.*$/gm, (match, prefix) => `${prefix}${" ".repeat(match.length - 1)}`);
}

export function parseValueImportSpecifiers(source: string): string[] {
  const imports: ImportReference[] = [];
  const sourceFile = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, false);

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      imports.push({
        specifier: statement.moduleSpecifier.text,
        index: statement.getStart(sourceFile),
      });
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.moduleSpecifier) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      imports.push({
        specifier: statement.moduleSpecifier.text,
        index: statement.getStart(sourceFile),
      });
    }
  }

  return imports
    .sort((a, b) => a.index - b.index)
    .map((item) => item.specifier)
    .filter((specifier, index, all) => all.indexOf(specifier) === index);
}

function walkSourceFiles(root: string, startDir: string): string[] {
  const absoluteStart = path.join(root, startDir);
  if (!existsSync(absoluteStart)) return [];

  const files: string[] = [];
  const stack = [absoluteStart];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const stat = statSync(current);
    if (stat.isDirectory()) {
      if (SKIPPED_DIRS.has(path.basename(current))) continue;
      for (const child of readdirSync(current)) {
        stack.push(path.join(current, child));
      }
      continue;
    }

    if (SOURCE_EXTENSION_SET.has(path.extname(current)) && !current.endsWith(".d.ts")) {
      files.push(current);
    }
  }

  return files.sort();
}

function hasEdgeRuntimeExport(source: string): boolean {
  return /\bexport\s+const\s+runtime\s*=\s*["']edge["']/.test(stripComments(source));
}

export function discoverEdgeEntrypoints(root = repoRoot()): string[] {
  const candidates = ["src/proxy", "src/middleware", "src/instrumentation"].flatMap((base) =>
    SOURCE_EXTENSIONS.map((extension) => path.join(root, `${base}${extension}`))
  );

  const entrypoints = new Set(candidates.filter((candidate) => existsSync(candidate)));

  for (const filePath of walkSourceFiles(root, "src")) {
    if (entrypoints.has(filePath)) continue;
    const source = readFileSync(filePath, "utf8");
    if (hasEdgeRuntimeExport(source)) {
      entrypoints.add(filePath);
    }
  }

  return [...entrypoints].sort();
}

function resolveSourceFile(root: string, importer: string, specifier: string): string | null {
  let basePath: string | null = null;

  if (specifier.startsWith("@/")) {
    basePath = path.join(root, "src", specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    basePath = path.resolve(path.dirname(importer), specifier);
  }

  if (!basePath) return null;

  const directCandidates = [basePath, ...SOURCE_EXTENSIONS.map((extension) => `${basePath}${extension}`)];
  for (const candidate of directCandidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = path.join(basePath, `index${extension}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }

  return null;
}

export function findEdgeRuntimeViolations(
  root = repoRoot(),
  entrypoints = discoverEdgeEntrypoints(root)
): EdgeRuntimeViolation[] {
  const violations: EdgeRuntimeViolation[] = [];

  for (const entrypoint of entrypoints) {
    const visited = new Set<string>();
    const stack: Array<{ filePath: string; chain: string[] }> = [
      { filePath: entrypoint, chain: [entrypoint] },
    ];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current.filePath)) continue;
      visited.add(current.filePath);

      const source = readFileSync(current.filePath, "utf8");
      for (const specifier of parseValueImportSpecifiers(source)) {
        if (NODE_BUILTINS.has(specifier)) {
          violations.push({
            entrypoint: relativeToRoot(root, entrypoint),
            importer: relativeToRoot(root, current.filePath),
            specifier,
            chain: current.chain.map((filePath) => relativeToRoot(root, filePath)),
          });
          continue;
        }

        const resolved = resolveSourceFile(root, current.filePath, specifier);
        if (!resolved || visited.has(resolved)) continue;
        stack.push({ filePath: resolved, chain: [...current.chain, resolved] });
      }
    }
  }

  return violations.sort((a, b) => {
    const entryCompare = a.entrypoint.localeCompare(b.entrypoint);
    if (entryCompare !== 0) return entryCompare;
    const importerCompare = a.importer.localeCompare(b.importer);
    if (importerCompare !== 0) return importerCompare;
    return a.specifier.localeCompare(b.specifier);
  });
}

export function formatViolations(violations: EdgeRuntimeViolation[]): string {
  return violations
    .map((violation) => {
      const chain = violation.chain.map((filePath) => `  - ${filePath}`).join("\n");
      return [
        `${violation.entrypoint}: Node builtin ${violation.specifier} is reachable from Edge runtime`,
        `Importer: ${violation.importer}`,
        "Import chain:",
        chain,
      ].join("\n");
    })
    .join("\n\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = repoRoot();
  const violations = findEdgeRuntimeViolations(root);
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exit(1);
  }
  console.log("No Edge runtime Node builtin import violations found.");
}
