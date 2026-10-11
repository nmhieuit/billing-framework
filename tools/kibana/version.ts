/** Phân tích `major.minor.patch` (bỏ hậu tố prerelease/build như `-SNAPSHOT`); trả null nếu không hợp lệ. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** So sánh hai phiên bản: âm nếu a < b, 0 nếu bằng nhau, dương nếu a > b; null nếu một trong hai không hợp lệ. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    const d = pa[i]! - pb[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

/** Trả về thông báo lỗi nếu `actual` thấp hơn `min` hoặc không đọc được; undefined nếu đạt yêu cầu. */
export function versionProblem(actual: string, min: string): string | undefined {
  const cmp = compareVersions(actual, min);
  if (cmp === null) return `Cannot parse Kibana version "${actual}"; need at least ${min}`;
  if (cmp < 0)
    return `Kibana ${actual} is older than the minimum ${min} required by the generated ES|QL rules`;
  return undefined;
}
