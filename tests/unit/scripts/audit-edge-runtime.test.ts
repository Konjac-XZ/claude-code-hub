import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  discoverEdgeEntrypoints,
  findEdgeRuntimeViolations,
  parseValueImportSpecifiers,
} from "../../../scripts/audit-edge-runtime";

let fixtureRoot: string | null = null;

function makeFixture(files: Record<string, string>): string {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "cch-edge-audit-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  return fixtureRoot;
}

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
});

describe("audit-edge-runtime", () => {
  test("parses only value imports and exports", () => {
    expect(
      parseValueImportSpecifiers(`
        import type { Socket } from "node:net";
        import { createHash } from "node:crypto";
        import "@/side-effect";
        import {
          value as multilineValue,
        } from "@/multiline";
        export type { Thing } from "@/types";
        export { value } from "@/value";
      `)
    ).toEqual(["node:crypto", "@/side-effect", "@/multiline", "@/value"]);
  });

  test("discovers proxy, instrumentation, and explicit edge runtime entrypoints", () => {
    const root = makeFixture({
      "src/proxy.ts": "export default function proxy() {}",
      "src/instrumentation.ts": "export async function register() {}",
      "src/app/api/edge/route.ts": 'export const runtime = "edge";',
      "src/app/api/node/route.ts": 'export const runtime = "nodejs";',
    });

    expect(discoverEdgeEntrypoints(root).map((filePath) => path.relative(root, filePath))).toEqual([
      "src/app/api/edge/route.ts",
      "src/instrumentation.ts",
      "src/proxy.ts",
    ]);
  });

  test("reports transitive Node builtin value imports reachable from Edge entrypoints", () => {
    const root = makeFixture({
      "src/proxy.ts": 'import { helper } from "@/lib/helper"; export default helper;',
      "src/lib/helper.ts": 'export { value } from "./node-only";',
      "src/lib/node-only.ts":
        'import { createHash } from "node:crypto"; export const value = createHash;',
    });

    expect(findEdgeRuntimeViolations(root)).toEqual([
      {
        entrypoint: "src/proxy.ts",
        importer: "src/lib/node-only.ts",
        specifier: "node:crypto",
        chain: ["src/proxy.ts", "src/lib/helper.ts", "src/lib/node-only.ts"],
      },
    ]);
  });

  test("ignores type-only Node builtin imports in reachable files", () => {
    const root = makeFixture({
      "src/proxy.ts": 'import { helper } from "@/lib/helper"; export default helper;',
      "src/lib/helper.ts": 'import type { Socket } from "node:net"; export const helper = 1;',
    });

    expect(findEdgeRuntimeViolations(root)).toEqual([]);
  });
});
