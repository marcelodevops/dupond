import fs from 'fs';
import path from 'path';

/**
 * Fail-closed lexical containment for artifact and delivery paths.
 *
 * Lives here rather than in deliveryHandler because coordinator.ts cannot import
 * deliveryHandler (deliveryHandler imports coordinator), and it must not be
 * weakened into a plain string-prefix test: path.resolve collapses `..`
 * segments, so a raw startsWith(base) check passes for `${base}/../outside`.
 *
 * Symlink canonicalisation is handled separately by the delivery writer's
 * O_NOFOLLOW / O_EXCL flags; artifact paths are read-only here.
 */
export function isPathLexicallyContained(baseDir: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(baseDir);
  const rel = path.relative(resolvedBase, path.resolve(targetPath));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Only accept keys usable as a single directory component. Dots are excluded on
 * purpose: a key like `implementation.js` is syntactically contained yet would
 * make the artifact lookup resolve to `implementation.js/implementation.js`.
 */
export const TASK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isSafePathSegment(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!TASK_KEY_PATTERN.test(value)) return false;
  return value.length <= 64;
}

export function readTextIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
