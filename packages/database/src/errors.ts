/** 2627: vi phạm PRIMARY KEY/UNIQUE constraint; 2601: vi phạm unique index. */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { number } = error as { number?: unknown };
  return number === 2627 || number === 2601;
}

/** 208: Invalid object name (bảng hoặc schema không tồn tại). */
export function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { number?: unknown }).number === 208;
}
