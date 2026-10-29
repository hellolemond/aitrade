import { defineConfig } from "vite";

export default defineConfig({
  // main.ts 用到顶层 await；系统 WebView（WebKit / WebView2）都支持 ES2022
  build: { target: "es2022" },
  server: {
    // The app loads this address during `mygo dev` (devUrl in mygo.config.ts).
    port: 5188,
    strictPort: true,
    watch: { ignored: ["**/.mygo/**", "**/build/**"] },
  },
});
