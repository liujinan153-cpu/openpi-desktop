# 联系我们 / 如何提问

## 提 Bug 前

1. 先看 [傻瓜安装指引](../docs/INSTALL-GUIDE.md) 和下方「常见问题」
2. 更新到最新版：⚙ 设置 → 检查更新
3. 搜一下 [已有 issue](https://github.com/liujinan153-cpu/openpi-desktop/issues?q=is%3Aissue) 是否重复

## 常见问题

**Q: 安装时提示「Windows 已保护你的电脑」？**
应用暂未购买代码签名证书，属预期。点「更多信息 → 仍要运行」。

**Q: 启动后模型报 401 / 余额不足？**
检查 ⚙ 设置 → API 密钥 的 Key 是否有效；点行内「⚡ 测试」按钮可直接验证连通性。

**Q: AI 报错「429 金额不足或无可用量」？**
模型服务商侧额度用尽，去服务商控制台充值或换模型。

**Q: 我贴的图片/文件去哪了？**
已自动保存到会话临时目录，聊天顶部有 toast 提示；引用时在输入框上方有 chip。

**Q: 换电脑后配置怎么迁移？**
复制 `~/.pi/agent/` 整个目录（含 auth.json 密钥与 sessions 会话记录）。

## 提问的正确姿势

- 报 Bug 用 [Bug 模板](https://github.com/liujinan153-cpu/openpi-desktop/issues/new?template=bug_report.md)，**附日志包**（⚙ 设置 → 📦 导出日志包，已脱敏）
- 一条 issue 只说一个问题
- 报错请贴原始文字（可复制），不要只发截图
