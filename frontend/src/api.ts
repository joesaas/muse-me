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

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
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
