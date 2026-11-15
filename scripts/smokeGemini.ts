/**
 * Opt-in Live Gemini Credential Smoke Test
 *
 * Disabled in ordinary CI. Must NEVER run automatically without explicit operator
 * authorization because it invokes the real Gemini API and may incur usage.
 *
 * Usage:
 *   DUPOND_ALLOW_LIVE_GEMINI_SMOKE=1 GEMINI_API_KEY="AIza..." npx tsx scripts/smokeGemini.ts
 */
import assert from 'node:assert';
import { getGeminiCredentialStatus, testGeminiConnection } from '../src/server/gemini.js';
import { parsePlan } from '../src/server/planning/planBreakdown.js';

async function main(): Promise<void> {
  if (process.env.DUPOND_ALLOW_LIVE_GEMINI_SMOKE !== '1') {
    console.error(
      'Refusing to run live Gemini smoke test without DUPOND_ALLOW_LIVE_GEMINI_SMOKE=1.',
    );
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY?.trim()) {
    console.error('GEMINI_API_KEY must be set to run the live Gemini smoke test.');
    process.exit(1);
  }

  const status = getGeminiCredentialStatus();
  assert.strictEqual(status.configured, true);
  console.log(`[smoke] Active source=${status.source}, model=${status.model}`);

  const testResult = await testGeminiConnection();
  assert.strictEqual(testResult.ok, true, `Connection test failed: ${testResult.error || 'unknown error'}`);
  console.log(`[smoke] Connection test passed at ${testResult.testedAt}`);

  const breakdown = await parsePlan(
    '# Live Smoke Plan\n1. Create health endpoint\n2. Add unit test',
    [{ name: 'Engineer', role: 'Coding Worker' }],
  );
  assert.ok(breakdown.tasks.length > 0, 'Expected at least 1 decomposed task from live Gemini.');
  console.log(`[smoke] Plan decomposition succeeded (${breakdown.tasks.length} tasks).`);
}

main().catch((err) => {
  console.error('[smoke] Failed:', err?.message || String(err));
  process.exit(1);
});
