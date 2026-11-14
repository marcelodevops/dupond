/**
 * Git reference / revision validation.
 *
 * Values from HTTP requests (targetBaseBranch, defaultBranch, baseCommit) are
 * interpolated into git command argv. Git parses leading dashes as options
 * (e.g. `git fetch --upload-pack=<cmd>`), so a ref value must be validated to
 * a plain refname / revision shape before it reaches execFileSync('git', ...).
 */
export function isSafeGitRef(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  if (value.length > 256) return false;
  // Option injection: git interprets a leading '-' as a command-line option.
  if (value.startsWith('-') || value.startsWith('/')) return false;
  // Refname-forbidden / shell-dangerous characters (whitespace, control chars,
  // ref separators, globs, escapes, shell operators).
  if (/[\s~^:?*[\\;|&`'"<>$()\x00-\x1f\x7f]/.test(value)) return false;
  if (value.includes('..') || value.includes('@{')) return false;
  if (value.endsWith('.lock') || value.endsWith('.') || value.endsWith('/')) return false;
  // Printable ASCII only.
  return /^[\x21-\x7e]+$/.test(value);
}
