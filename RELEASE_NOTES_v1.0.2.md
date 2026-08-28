# CoyoteLink v1.0.2

这是一个针对自定义 HTTPS 端口兼容性的补丁版本。

## 修复

- 修复同一公开端口同时承载 HTTP→HTTPS 跳转和 HTTPS/WSS 时的 TCP 首包竞态。
- 首个协议判别数据块到达后会立即暂停客户端 socket；只有内部上游连接完成并挂接双向 pipe 后才恢复读取。
- 避免较大的、被拆分成多个 TCP 数据块的 TLS ClientHello 在分流窗口中丢字节。该问题可能表现为 Android Chrome 的 `ERR_CONNECTION_CLOSED`。

## 保持不变

- 不改变现有部署端口、域名、SSL 文件位置和 systemd service。
- 不改变 `/ws`、`/v4`、`/healthz` 路径。
- 明文 `http://域名:自定义端口/` 仍在同一端口返回 HTTPS 308。
- DG-LAB Socket V4 与房间控制逻辑未改动。

## 验证

GitHub CI 检查 Node/Shell 语法、HTTP 模式、TLS 单端口 HTTPS、HTTP 308、分片 TCP 请求、二维码生成与敏感静态路径隔离。

> 该修复解决的是服务器端可确认的 TCP 分流竞态。Android Chrome 的最终兼容性仍应在实际手机网络环境中回归验证。
