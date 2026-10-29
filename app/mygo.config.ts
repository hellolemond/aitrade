import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "AiTrade",
  identifier: "dev.aitrade.app",
  version: "0.1.0",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  devUrl: "http://localhost:5188",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
  // 自动更新：tag v* 触发 .github/workflows/release.yml 构建并上传到草稿 Release，
  // 发布后已安装的 App 从 GitHub releases/latest 拉取、验签、安装。
  // publicKey 对应的私钥在 GitHub Secret MYGO_UPDATER_PRIVATE_KEY，丢失后旧版本将无法再更新。
  updates: {
    publicKey: "U+NF7bCIao6AcY/TtT9H+xviYwgq+CW0t/QpIuzXVGw=",
    github: "hellolemond/aitrade",
  },
});
