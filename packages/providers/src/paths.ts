import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolves a configured relative path against the pnpm workspace root (the
 * nearest ancestor with pnpm-workspace.yaml), so the web app (cwd apps/web)
 * and the worker (cwd apps/worker) share the same local storage directory.
 * Absolute paths are returned unchanged.
 */
export function resolveFromWorkspace(p: string, cwd: string = process.cwd()): string {
  if (path.isAbsolute(p)) return p;
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return path.resolve(dir, p);
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd, p);
    dir = parent;
  }
}
