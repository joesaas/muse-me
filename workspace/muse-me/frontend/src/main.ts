import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { setUnauthorizedHandler } from "./api";
import router from "./router";
import { useAppStore } from "./stores/app";
import "./assets/main.css";

const pinia = createPinia();
const app = createApp(App).use(pinia).use(router);

// API 层 401 时回到登录门：只改会话状态，不操作 DOM。
setUnauthorizedHandler(() => useAppStore(pinia).setLoggedOut());

app.mount("#app");
