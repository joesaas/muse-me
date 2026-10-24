// fetch 封装：统一 JSON、统一错误；401 时回调已注册的未登录处理
// （由 main.ts 注入为 Pinia store 的 setLoggedOut），本模块不反向依赖 store，避免循环导入。
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: (() => void) | null = null;

/**
 * 角色防御性归一化：历史数据里 system 曾被前端写成 sys，读到旧值时
 * 映射为 system，保证系统消息拿到 .msg.system 样式。
 */
export function normalizeMessageRole(role: string): string {
  return role === "sys" ? "system" : role;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** 把各类异常翻译成人话错误文案（视图统一三态与动作容错共用）。 */
export function apiErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "登录已过期，请重新进入";
    // 服务端错误体多为 {"error": "..."}，能解析就只取 error 字段。
    try {
      const parsed = JSON.parse(e.message) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) return `请求失败：${parsed.error}`;
    } catch {
      /* 非 JSON 文本直接用原文 */
    }
    return e.message ? `请求失败（${e.status}）：${e.message}` : `请求失败（${e.status}）`;
  }
  if (e instanceof TypeError) return "网络连接失败，请检查后重试";
  return e instanceof Error ? e.message : "请求失败，请重试";
}

/**
 * 文件下载走 api 层（四维评审 FE-13）：同源 fetch 携带会话 cookie，
 * 401 时触发登录门而不是让浏览器整页跳到 401 JSON；成功后以 blob 触发下载。
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const r = await fetch(path);
  if (r.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, "unauthorized");
  }
  if (!r.ok) throw new ApiError(r.status, (await r.text()) || String(r.status));
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (r.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, "unauthorized");
  }
  if (!r.ok) throw new ApiError(r.status, (await r.text()) || String(r.status));
  return (r.status === 204 ? null : await r.json()) as T;
}
