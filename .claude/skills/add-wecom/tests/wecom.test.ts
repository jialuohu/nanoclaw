import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('wecom skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: wecom');
    expect(content).toContain('version: 1.0.0');
  });

  it('has all files declared in adds', () => {
    const channelFile = path.join(skillDir, 'add', 'src', 'channels', 'wecom.ts');
    expect(fs.existsSync(channelFile)).toBe(true);
    const content = fs.readFileSync(channelFile, 'utf-8');
    expect(content).toContain('class WeComChannel');
    expect(content).toContain("registerChannel('wecom'");

    const testFile = path.join(skillDir, 'add', 'src', 'channels', 'wecom.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const cryptoFile = path.join(skillDir, 'add', 'src', 'wecom-crypto.ts');
    expect(fs.existsSync(cryptoFile)).toBe(true);
    const cryptoContent = fs.readFileSync(cryptoFile, 'utf-8');
    expect(cryptoContent).toContain('deriveAESKey');
    expect(cryptoContent).toContain('parseWeComXml');
  });

  it('has modify file with wecom import', () => {
    const indexFile = path.join(skillDir, 'modify', 'src', 'channels', 'index.ts');
    expect(fs.existsSync(indexFile)).toBe(true);
    const content = fs.readFileSync(indexFile, 'utf-8');
    expect(content).toContain("import './wecom.js'");
  });

  it('has intent file for modified barrel', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'),
      ),
    ).toBe(true);
  });
});
