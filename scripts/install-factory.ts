/** Official clients share one validated update transaction. */
import { updateProviders } from './update-providers.ts';
import { fileURLToPath } from 'node:url';
await updateProviders(fileURLToPath(new URL('..', import.meta.url)));
