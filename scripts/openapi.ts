import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../src/api/openapi.ts';

writeFileSync('docs/openapi.json', `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, 'utf8');
console.log('docs/openapi.json zapisany');
