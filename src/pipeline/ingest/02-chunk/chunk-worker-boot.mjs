// Bootstrap for chunk-worker.ts. Worker threads can't load .ts files directly, so this
// tiny plain-JS shim registers tsx's TypeScript loader for THIS thread first, then
// dynamically imports the real (TypeScript) worker logic. See chunk-pool.ts for why.
import { register } from 'tsx/esm/api';

register();
await import('./chunk-worker.ts');
