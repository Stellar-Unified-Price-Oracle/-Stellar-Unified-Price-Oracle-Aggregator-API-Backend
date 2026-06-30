import fs from 'fs';
import path from 'path';
import { swaggerSpec } from '../src/services/openapi';

const outputPath = path.resolve(__dirname, '../openapi.json');

fs.writeFileSync(outputPath, JSON.stringify(swaggerSpec, null, 2) + '\n');
console.log(`OpenAPI spec exported to ${outputPath}`);
