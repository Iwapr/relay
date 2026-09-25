# 界面演示素材

`desktop.png`、`mobile.png` 是真实页面截图；对应 GIF 由同一段操作中的截图按顺序组成，每帧停留两秒。使用隔离浏览器测试 Provider、固定的 demo 显示身份和模拟的远程管理状态，不登录真实 AI 账号、不读取用户项目、不执行云端部署。

重新生成需要项目依赖、Playwright Chromium 和 ffmpeg：

```bash
npm exec playwright -- install chromium
npm run docs:media
```

流程启动独立测试服务，打开演示项目，发送固定的演示问题，再查看文件和远程管理窗口。预览正文和回复都来自明确的测试数据。测试服务退出后清理临时实例；录制中间帧保存在被 Git 忽略的 `.runtime/readme-media/`。
