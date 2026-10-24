import { NotFound } from "../domain/errors.js";
import type { FileStore, ScriptStore } from "../domain/ports.js";
import type { FileRecord } from "../domain/types.js";

export interface DownloadResult {
  filename: string;
  content: string;
}

/**
 * 键序稳定化 JSON（同 Python 口径）：脚本 doc 在 Python 存储层以
 * sort_keys 落库，下载时 json.dumps(indent=2) 输出即键序排序后的文本。
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const parts = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify(
            (value as Record<string, unknown>)[k],
          )}`,
      );
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stablePretty(value: unknown): string {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2);
}

/**
 * 文件用例（同 Python api._download）：列表读登记表；下载只支持 script: ref，
 * 按脚本当前 doc 现拼导出 JSON，其余 ref 明确 404。
 */
export class FileService {
  constructor(
    private readonly files: FileStore,
    private readonly scripts: ScriptStore,
    private readonly userId: string,
  ) {}

  list(): FileRecord[] {
    return this.files.listFiles(this.userId);
  }

  download(fileId: string): DownloadResult {
    const row = this.files.getFile(fileId);
    if (!row) throw new NotFound(`文件不存在：${fileId}`);
    const ref = row.ref ?? "";
    if (ref.startsWith("script:")) {
      const script = this.scripts.getScript(ref.slice("script:".length));
      if (!script) throw new NotFound("脚本已不存在");
      return { filename: row.name, content: stablePretty(script.doc) };
    }
    throw new NotFound("该文件暂不支持下载");
  }
}
