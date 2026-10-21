export async function divideAsync(a: number, b: number): Promise<number> {
  if (b === 0) {
    throw new Error('division by zero');
  }
  return a / b;
}

export type DivideResult = { ok: true; value: number } | { ok: false; error: string };

export async function safeDivide(a: number, b: number): Promise<DivideResult> {
  try {
    const value = await divideAsync(a, b);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
