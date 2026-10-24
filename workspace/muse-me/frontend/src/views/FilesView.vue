<script setup lang="ts">
// 我的文件：列表 + 下载（download 端点直链，与旧版一致）。
import { onMounted, ref } from "vue";
import { api } from "../api";
import type { FileItem } from "../types";

const list = ref<FileItem[]>([]);

async function loadFiles(): Promise<void> {
  list.value = await api<FileItem[]>("/api/files");
}

onMounted(loadFiles);
</script>

<template>
  <section class="view">
    <div class="bar"><h2>我的文件</h2></div>
    <div class="cards">
      <div v-for="f in list" :key="f.id" class="card">
        <h3>{{ f.name }}</h3>
        <p class="muted">{{ f.kind }} · {{ f.created_at }}</p>
        <div class="row">
          <a :href="`/api/files/${f.id}/download`"><button>下载</button></a>
        </div>
      </div>
      <p v-if="!list.length" class="muted">还没有文件。脚本和评估报告会存到这里。</p>
    </div>
  </section>
</template>
