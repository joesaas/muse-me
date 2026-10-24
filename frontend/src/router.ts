// 路由与侧栏菜单一一对应。后端静态服务无 SPA fallback，必须 hash 模式。
import { createRouter, createWebHashHistory } from "vue-router";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", name: "chat", component: () => import("./views/ChatView.vue"), meta: { chatId: undefined as string | undefined } },
    { path: "/chat/:id", name: "chat-detail", component: () => import("./views/ChatView.vue") },
    { path: "/feed", name: "feed", component: () => import("./views/FeedView.vue") },
    { path: "/scripts", name: "scripts", component: () => import("./views/ScriptsView.vue") },
    { path: "/jobs", name: "jobs", component: () => import("./views/JobsView.vue") },
    { path: "/approvals", name: "approvals", component: () => import("./views/ApprovalsView.vue") },
    { path: "/files", name: "files", component: () => import("./views/FilesView.vue") },
    { path: "/runs", name: "runs", component: () => import("./views/RunsView.vue") },
    { path: "/memories", name: "memories", component: () => import("./views/MemoriesView.vue") },
    { path: "/settings", name: "settings", component: () => import("./views/SettingsView.vue") },
  ],
});

export default router;
