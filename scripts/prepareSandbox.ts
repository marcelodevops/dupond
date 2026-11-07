import { SandboxExecutor } from '../src/server/sandbox/sandboxExecutor.ts';

async function main() {
  const executor = new SandboxExecutor();
  const available = executor.isAvailable();
  console.log(`[Sandbox Prep] Host platform runtime: ${available.mechanism} (available: ${available.available})`);
  const ok = await executor.ensureImage('node:22-bookworm', 300000);
  if (!ok) {
    console.error('[Sandbox Prep] Failed to prepare sandbox container image');
    process.exit(1);
  }
  console.log('[Sandbox Prep] Container sandbox image prepared successfully.');
}

main().catch((err) => {
  console.error('[Sandbox Prep] Unexpected error during image prep:', err);
  process.exit(1);
});
