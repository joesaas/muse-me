<script setup lang="ts">
// 我的文件：列表 + 下载。
// 下载走 api 层拉 blob 再触发下载（四维评审 FE-13）：
// 会话过期时触发登录门，不再让浏览器整页跳到 401 JSON；
// 文件类别只经 labels.ts 人话映射渲染。
import { onMounted } from "vue";
import { api, downloadFile } from "../api";
import { useActionState, useAsyncList } from "../composables/useAsyncList";
import { fileKindLabel } from "../labels";
import type { FileItem } from "../types";

const files = useAsyncList<FileItem>(() => api<FileItem[]>("/api/files"));
const action = useActionState();

async function download(f: FileItem): Promise<void> {
  await action.runAction(`download-${f.id}`, async () => {
    await downloadFile(`/api/files/${f.id}/download`, f.name);
  });
}

onMounted(files.load);
</script>

<template>
  <section class="view">
    <div class="bar"><h2>我的文件</h2></div>
    <p v-if="files.loading.value" class="muted">正在加载文件…</p>
    <p v-else-if="files.error.value" class="err">
      文件加载失败：{{ files.error.value }} <button @click="files.retry">重试</button>
    </p>
    <p v-else-if="!files.items.value.length" class="muted">还没有文件。脚本和评估报告会存到这里。</p>
    <div v-else class="cards">
      <div v-for="f in files.items.value" :key="f.id" class="card">
        <h3>{{ f.name }}</h3>
        <p class="muted">{{ fileKindLabel(f.kind) }} · {{ f.created_at }}</p>
        <div class="row">
          <button :disabled="action.busy.value !== null" @click="download(f)">下载</button>
        </div>
      </div>
    </div>
    <p v-if="action.error.value" class="err">{{ action.error.value }}</p>
  </section>
</template>
