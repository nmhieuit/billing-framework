import { describe, expect, it } from 'vitest';
import { compareVersions, versionProblem } from './version.js';

describe('versionProblem', () => {
  it('accepts versions at or above the minimum', () => {
    expect(versionProblem('9.4.0', '9.4.0')).toBeUndefined();
    expect(versionProblem('9.4.4', '9.4.0')).toBeUndefined();
    expect(versionProblem('9.10.0', '9.4.0')).toBeUndefined();
    expect(versionProblem('10.0.0', '9.4.0')).toBeUndefined();
  });

  it('ignores prerelease and build suffixes', () => {
    expect(versionProblem('9.4.4-SNAPSHOT', '9.4.0')).toBeUndefined();
    expect(versionProblem('9.4.0-rc1', '9.4.0')).toBeUndefined();
    expect(versionProblem('9.3.9-SNAPSHOT', '9.4.0')).toContain('older');
  });

  it('rejects older versions with a clear message', () => {
    expect(versionProblem('9.3.9', '9.4.0')).toBe(
      'Kibana 9.3.9 is older than the minimum 9.4.0 required by the generated ES|QL rules',
    );
    expect(versionProblem('8.19.0', '9.4.0')).toContain('older than the minimum 9.4.0');
  });

  it('treats garbage as incompatible', () => {
    for (const v of ['', 'abc', '9.4', '9.x.1']) {
      expect(versionProblem(v, '9.4.0')).toContain('Cannot parse Kibana version');
    }
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('9.10.0', '9.4.0')).toBeGreaterThan(0);
    expect(compareVersions('9.4.0', '9.4.0')).toBe(0);
  });
});
