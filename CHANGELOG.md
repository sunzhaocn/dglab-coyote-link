# Changelog

本项目采用语义化版本号。公开 GitHub 首发从 `v1.0.0` 开始；此前 `v0.x` 为项目迭代阶段版本。

## [1.0.2] - 2026-08-28

### Android Chrome / TLS compatibility

- 修复 SSL 单端口 HTTP/HTTPS 分流中的首包竞态：分流器读取首个判别数据块后立即暂停客户端 socket，在内部 HTTP/HTTPS 上游建立并挂接 pipe 前不再消费后续字节，避免分片 TLS ClientHello 或分片 HTTP 请求在空窗期被丢弃。
- 保持原有单自定义端口行为不变：HTTPS/WSS 继续直接工作，明文 HTTP 继续在同一端口返回 308 跳转。
- 增加 TLS 单端口 CI：自签名证书启动、HTTPS `/healthz`、HTTP 308，以及多轮分片请求回归检查。
- 版本升级到 `1.0.2`。

## [1.0.1] - 2026-08-28

### Security / repository hardening

- 修复服务器把整个安装目录当作静态目录的问题；现在仅公开 `index.html`、`app.js` 与明确 API 路径，避免 `server.js`、部署脚本、备份以及 `domains/*/ssl/` 下的 TLS 私钥被 HTTP 直接读取。
- TLS 同端口协议探测增加 10 秒首字节超时，减少空闲 TCP 连接长期占用。
- CI 增加完整性校验、QR 生成和敏感静态路径不可访问检查。
- 补齐 GitHub Actions、Issue 模板、架构/波形文档和 `vendor/qrcode/` 第三方运行文件。

## [1.0.0] - 2026-08-27

### Public release

- 项目正式命名为 **CoyoteLink · 郊狼互控**。
- GitHub 仓库：`sunzhaocn/dglab-coyote-link`。
- 基于 v0.23 的运行代码整理公开仓库结构，不改变既有 Linux 安装目录与 service 名，保证 v0.x 更新兼容。
- 补充 GPL-3.0 根许可证、上游归属、贡献、安全、架构、波形格式与 GitHub Issue 模板。
- 新增 GitHub Actions：Node 语法、Shell 语法与 `/healthz` 启动检查。

### Included functionality

- DG-LAB Socket V4 配对二维码与 relay。
- 双人房间、主动授权与单双设备控制模型。
- A/B 通道纯 `AddIntensity` 的 `±1` 控制及长按连续增减。
- 实际强度回读、差值纠错、设备/APP 上限识别。
- 自定义波形导入、编辑、添加小节、本地预设、A/B/A+B 应用。
- 触摸模式及通道切换 pointer 会话清理。
- 移动端响应式布局、连接区域折叠、房间加入/离开互斥 UI。
- 页面防误触：选择/复制/粘贴、缩放和拖动限制。
- 同一自定义端口提供 HTTP(S)、`/ws`、`/v4`、`/healthz`；SSL 下同端口 HTTP → HTTPS 308。
- Linux 一键部署、原地更新、健康检查、失败回滚；Windows Server 部署脚本。

## Pre-1.0 milestones

### v0.23
- 优化桌面端配对二维码与说明区域间距、容器宽度。

### v0.22
- 加入/离开房间按钮互斥显示；连接设备区域支持展开/收起；加强网页防复制/粘贴与拖动。

### v0.21
- 修复触摸模式切换 A/B/A+B 时旧 `pointercapture` 事件导致新会话卡死的竞态。

### v0.20
- 修复 UI `+1` 但设备实际 `+2`：按钮链路改为纯相对强度，闭环也使用差值 `AddIntensity` 纠错；新增离开房间。

### v0.19
- 增加自定义波形工作台、添加小节、导入/导出和触摸模式。

### v0.18
- `±1` 长按改用 V4 `AddIntensity(t=3)` 相对直控。

### v0.15
- 增加设备实际强度闭环校验和高端上限误学习保护。

### v0.14
- 调整临时任务续租，修复目标强度周期性归零问题。

### v0.12
- 增加高端实际强度收敛；SSL 模式支持同一自定义端口 HTTP 308 → HTTPS。
