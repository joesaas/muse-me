/** SQLite JSON 列的解析小工具：坏 JSON 回退默认值，不让存储层抛错逸出。 */

export function parseJsonObject(
  text: string | null | undefined,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!text) return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 落回 fallback
  }
  return fallback;
}
