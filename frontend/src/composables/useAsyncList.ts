// 统一三态（四维评审 FE-5）：加载骨架 / 错误重试 / 空态。
// 所有视图的列表加载都经 useAsyncList，失败时 error 非空，
// 模板按 loading → error → empty → list 的顺序分支，
// 绝不把加载失败渲染成空态文案。
import { ref } from "vue";
import { ApiError, apiErrorText } from "../api";

export function useAsyncList<T>(loader: () => Promise<T[]>) {
  const items = ref<T[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      items.value = await loader();
    } catch (e) {
      error.value = apiErrorText(e);
    } finally {
      loading.value = false;
    }
  }

  function retry(): Promise<void> {
    return load();
  }

  return { items, loading, error, load, retry };
}

/** 动作级容错（trial/run/bind/decide/toggle 等）：进行中标记 + 错误文案。 */
export function useActionState() {
  const busy = ref<string | null>(null);
  const error = ref<string | null>(null);

  async function runAction(key: string, fn: () => Promise<void>): Promise<boolean> {
    if (busy.value) return false;
    busy.value = key;
    error.value = null;
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // 401 已由 api 层触发登录门，这里不再重复提示。
        return false;
      }
      error.value = apiErrorText(e);
      return false;
    } finally {
      busy.value = null;
    }
  }

  return { busy, error, runAction };
}
