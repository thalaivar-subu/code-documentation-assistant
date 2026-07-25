/**
 * Dev script — verify Query Stage 1 (Route) from the terminal.
 *
 * No repo/index needed — routing only looks at the question text.
 *
 * Usage:
 *   npm run route -- "<question>"
 *
 * Examples:
 *   npm run route -- "What does RecordTaskDuration do?"
 *   npm run route -- "Who calls chunkRepo?"
 *   npm run route -- "How does authentication work in this system?"
 */

import { routeQuery } from '../pipeline/query/01-route/route.ts';

const question = process.argv.slice(2).join(' ');
if (!question) {
  console.error('Usage: npm run route -- "<question>"');
  process.exit(1);
}

const result = routeQuery(question);

console.log('\n── Query · Stage 1: Route ──────────────────────────────────────');
console.log(`  question   "${question}"`);
console.log(`  intent     ${result.intent}`);
console.log(`  symbols    [${result.symbols.join(', ')}]`);
console.log(`  files      [${result.files.join(', ')}]`);
console.log(`  reason     ${result.reason}`);
console.log('────────────────────────────────────────────────────────────────\n');
