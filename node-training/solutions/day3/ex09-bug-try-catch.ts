export async function loadOrDefault(load: () => Promise<number>, fallback: number): Promise<number> {
  try {
    return await load();
  } catch {
    return fallback;
  }
}
