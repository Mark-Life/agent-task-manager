/**
 * Package nodes, read from `package.json` alone — no checker. One node per
 * workspace package, a `depends` edge per `workspace:*` dependency, plus the
 * fixed external bucket every vendored declaration is attributed to.
 *
 * A package with a `package.json` and no `tsconfig.json` still appears, with no
 * children under it. That is the honest drawing: `packages/typescript-config`
 * is a real workspace that declares no code.
 */

import { EXTERNAL_PACKAGE_ID, nodeId, type PackageNode } from "../graph";
import { readManifest, workspacePatterns } from "./session";

/** A workspace dependency, as `package.json` spells one. */
const WORKSPACE_PROTOCOL = "workspace:";

const APPS_PREFIX = "apps/";

/** The bucket for anything declared under `node_modules`. */
const externalPackage: PackageNode = {
  dir: "",
  group: "external",
  id: EXTERNAL_PACKAGE_ID,
  kind: "package",
  label: "external",
  npmName: "external",
  origin: "external",
  pkg: EXTERNAL_PACKAGE_ID,
};

/** Every workspace package under `root`, plus `pkg:external` and the `depends` pairs. */
export const readPackages = async (root: string) => {
  const patterns = await workspacePatterns(root);
  const nodes: PackageNode[] = [externalPackage];
  const manifests = new Map<string, Awaited<ReturnType<typeof readManifest>>>();

  for (const pattern of patterns) {
    const scan = new Bun.Glob(`${pattern}/package.json`).scan({
      cwd: root,
      onlyFiles: true,
    });
    // biome-ignore lint/performance/noAwaitInLoops: a directory scan is a stream, and each manifest is read as it arrives
    for await (const match of scan) {
      const dir = match.slice(0, -"/package.json".length);
      const manifest = await readManifest(`${root}/${match}`);
      const npmName = manifest?.name;
      if (!npmName) {
        continue;
      }
      manifests.set(npmName, manifest);
      nodes.push({
        dir,
        group: dir.startsWith(APPS_PREFIX) ? "app" : "package",
        id: nodeId.package(npmName),
        kind: "package",
        label: npmName.replace("@workspace/", ""),
        npmName,
        origin: "workspace",
        pkg: nodeId.package(npmName),
      });
    }
  }

  const known = new Set(manifests.keys());
  const dependencies: { readonly source: string; readonly target: string }[] =
    [];
  for (const [npmName, manifest] of manifests) {
    const declared = {
      ...manifest?.dependencies,
      ...manifest?.devDependencies,
    };
    for (const [name, range] of Object.entries(declared)) {
      if (range.startsWith(WORKSPACE_PROTOCOL) && known.has(name)) {
        dependencies.push({
          source: nodeId.package(npmName),
          target: nodeId.package(name),
        });
      }
    }
  }

  return { dependencies, nodes: nodes.sort(byDirLength) };
};

// Longest directory first, so `packages/db/src/x.ts` matches `packages/db`
// before a hypothetical `packages` ever could.
const byDirLength = (a: PackageNode, b: PackageNode) =>
  b.dir.length - a.dir.length;

/**
 * Which package a repo-relative file belongs to. Anything outside every
 * workspace directory — a vendored declaration — belongs to the external bucket.
 */
export const packageIdIn =
  (packages: readonly PackageNode[]) => (file: string) =>
    packages.find(
      (candidate) =>
        candidate.dir !== "" && file.startsWith(`${candidate.dir}/`)
    )?.id ?? EXTERNAL_PACKAGE_ID;
