# CoyoteLink v1.0.0

这是 CoyoteLink · 郊狼互控的首个公开 GitHub Release，运行代码基于此前 v0.23 整理。

## Highlights

- DG-LAB Socket V4 配对与自托管 relay
- 双人房间、单双设备互控与设备所有者授权
- A/B 通道 `±1` 相对强度控制与长按连续增减
- 实际强度回读与差值纠错
- 自定义波形导入/编辑/添加小节/保存/导出
- A / B / A+B 触摸控制模式
- 手机与桌面响应式布局
- 连接二维码区域可折叠、加入/离开房间互斥 UI
- 急停、房间心跳、断联归零与后台安全停止
- Linux 一键部署/更新/回滚，Windows Server 部署脚本
- 单自定义端口提供 Web、`/ws`、`/v4`、`/healthz`
- SSL 模式同端口 HTTP 自动 308 → HTTPS，不主动接管 80/443

## Upgrade from v0.x

已有 Linux 部署可直接：

```bash
cd /root/解压后的dglab-coyote-link-v1.0.0
sudo bash update.sh
```

现有端口、域名、SSL、证书和 `/etc/dglab-mutual/config.env` 会保留。

## Notes

- 本项目是非官方 DG-LAB 兼容项目。
- 浏览器拥有 V4 控制会话；切后台会执行安全停止，不承诺后台持续控制。
- 软件失联保护是 best-effort，不是硬件安全系统。
- 首次公开版本采用 GPL-3.0-only，并保留上游与第三方许可证说明。
