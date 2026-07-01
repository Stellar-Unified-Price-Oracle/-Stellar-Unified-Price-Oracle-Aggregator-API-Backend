import fs from 'fs';
import path from 'path';

describe('SDK generation workflow', () => {
  it('exposes a multi-language SDK generation script', () => {
    const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    expect(packageJson.scripts['generate:sdks']).toBeDefined();
  });
});
