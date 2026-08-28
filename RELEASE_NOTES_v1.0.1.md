# CoyoteLink v1.0.1

这是 v1.0.0 首发后的安全与仓库完整性修复版本。

## 重点修复

- **静态文件边界修复**：服务端不再把安装目录作为通用静态目录；只公开 `index.html`、`app.js` 与明确 API/WebSocket 路径。这样部署目录内的 `server.js`、脚本、备份和 `domains/*/ssl/` TLS 私钥不会被网页路径直接读取。
- **完整源码恢复**：补齐 `vendor/qrcode/`、`.github/` 与 `docs/`。缺少 `vendor/qrcode/` 时服务端无法正常启动。
- **连接硬化**：TLS/HTTP 协议探测连接增加 10 秒空闲超时。
- **CI 增强**：校验源码完整性、健康检查、QR 生成，并验证 `/server.js`、`/package.json` 返回 404。

## 更新

已部署 v0.x / v1.0.0：

```bash
cd /root/解压后的dglab-coyote-link-v1.0.1
sudo bash update.sh
```

更新脚本会继续保留既有端口、域名、SSL、配置与 `run.sh`。
