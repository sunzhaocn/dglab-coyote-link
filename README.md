# CoyoteLink · 郊狼互控

[![Release](https://img.shields.io/badge/release-v1.0.1-111111)](https://github.com/sunzhaocn/dglab-coyote-link/releases)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20-43853d)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![DG-LAB](https://img.shields.io/badge/DG--LAB-Socket%20V4-d6ae55)](OFFICIAL_SOCKET.md)

**CoyoteLink** 是一个基于 **DG-LAB Socket V4** 的非官方双人远程互控 Web 项目。它提供双人房间、A/B 通道强度控制、自定义波形、触摸控制、设备授权和失联归零等功能，可自托管在 Linux 或 Windows Server。

> [!IMPORTANT]
> 本项目不是 DG-LAB 官方产品，与 DG-LAB 官方无隶属或背书关系。项目依据公开协议与开源实现进行兼容开发，相关上游与许可证说明见 [NOTICE.md](NOTICE.md) 和 [OFFICIAL_SOCKET.md](OFFICIAL_SOCKET.md)。

## 功能

- **双人房间**：两人进入同一房间后互相发现；一方有设备时可单向控制，双方都有设备时可双向互控。
- **主动授权**：设备所有者必须开启“允许对方控制我的设备”。
- **A/B 独立控制**：按钮短按 `±1`，长按连续通过 V4 `AddIntensity` 相对调节，并回读实际强度做闭环纠错。
- **自定义波形**：支持导入、编辑、添加/删除/排序 100 ms 小节、本地保存、导出，以及分别应用到 A/B/A+B。
- **触摸模式**：横向映射波形频率，纵向映射强度；支持 A、B、A+B，松手即结束触摸输出。
- **官方 Socket V4 配对**：网页生成 DG-LAB APP 配对二维码与手动连接地址。
- **连接区可折叠**：二维码展开/收起不主动关闭现有 V4 控制会话。
- **失联保护**：房间心跳、远端保活、设备状态回读、急停、页面切后台归零。
- **单端口部署**：网页、`/ws`、`/v4`、`/healthz` 共用一个自定义端口；启用 SSL 后同端口明文 HTTP 自动 308 到 HTTPS。
- **不接管 80/443**：除非你明确把项目端口设置为 80 或 443，否则不会修改现有站点或反向代理。
- **移动端适配**：窄屏布局、按钮尺寸、通道标题、触摸面板均针对手机优化。

## 快速开始

### 环境

- Node.js **20+**
- 推荐 Linux 服务器；Windows Server 也提供部署脚本
- 若使用 HTTPS/WSS，需要自己的证书与私钥
- 使用 DG-LAB APP 通过 Socket V4 配对

### Linux 一键部署

```bash
sudo bash deploy.sh
```

向导会依次询问公网端口、域名/IP、SSL 与证书配置，最终确认后再安装。

例如：

```bash
sudo bash deploy.sh --port 8443 --domain control.example.com --ssl --yes
```

如果只使用 HTTP/WS：

```bash
sudo bash deploy.sh --port 8787 --no-ssl --yes
```

Linux 默认安装到：

```text
/opt/dglab-mutual-web
```

内部服务名与安装目录继续保留 `dglab-mutual-web` / `dglab-mutual`，用于兼容 v0.x 已部署实例；这不影响公开项目名称 CoyoteLink。

### 从 v0.x 更新

把新版本解压到任意目录后：

```bash
cd /root/dglab-coyote-link
sudo bash update.sh
```

更新脚本会保留既有：

- 公网端口
- 域名
- SSL/证书目录
- `/etc/dglab-mutual/config.env`
- `run.sh`

更新失败会尝试自动回滚旧程序。

### Windows Server

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

## 使用流程

1. 打开网页，输入 8–12 位房间号并加入。
2. 需要连接设备的一方展开“连接我的郊狼”，建立 V4 控制端。
3. 使用 DG-LAB APP 扫描二维码，或打开配对链接。
4. APP 暴露设备后，网页读取 A/B 实际强度和可用上限。
5. 设备所有者打开“允许对方控制我的设备”。
6. 对方即可使用 `±1`、波形或触摸模式进行控制。
7. 任何一方均可使用底部急停；离开房间会清理远程控制关系，但不会主动要求重新扫码本机设备。

## 房间号规则

```text
长度：8–12 位
字符：A-Z / 0-9
输入自动转大写
```

浏览器和服务器都会校验。

## 自定义波形

郊狼 V3 波形数据以约 100 ms 为一个块，每块包含 4 组 25 ms 的频率/力度数据。本项目编辑器按以下范围校验：

```text
频率：10–240
波形力度：0–100
```

支持导入 `.json`、`.txt`、`.wave`、`.dglab`。JSON 示例：

```json
{
  "name": "My Wave",
  "frames": [
    "0A0A0A0A00000000",
    "0A0A0A0A64646464"
  ]
}
```

更完整的格式说明见 [docs/WAVEFORM_FORMAT.md](docs/WAVEFORM_FORMAT.md)。

## 触摸模式

- 横向：波形频率
- 纵向：通道强度
- 可选 A / B / A+B
- 触摸波形力度与最高强度比例可配置
- 触摸数据按接近设备 100 ms 节奏合并，仅发送最新位置
- 松手、`pointercancel`、切换模式、切后台、急停或连接失效会结束当前触摸会话

## 失联与安全机制

服务端只公开 `index.html`、`app.js` 和明确声明的 API/WebSocket 路径；`server.js`、部署脚本、备份目录以及 `domains/*/ssl/` 中的证书/私钥不会作为静态文件对外提供。


CoyoteLink 把“失联后尽快归零”作为核心设计，但任何浏览器/WebSocket/BLE 链路都不能保证零延迟故障检测。

- 房间网页约每 1 秒发送应用层心跳；服务端约 4.5 秒未收到即判定掉线。
- 远程控制有独立保活；超时后被控端执行归零。
- APP/设备断开后清理 ready 状态并尝试归零。
- 页面进入后台时执行急停；**本项目不保证浏览器后台持续控制或持续配对稳定性**。
- 底部“急停 · 双方归零”同时处理本机并向房间另一方发出停止指令。

> [!WARNING]
> 请先以低强度测试设备、网络和波形。软件保护只能降低风险，不能代替设备自身限制、用户判断或物理断开手段。不要把网页状态当作硬件安全保证。

## HTTPS / 单端口行为

假设部署端口为 `8443`：

```text
https://example.com:8443/          网页
wss://example.com:8443/ws          双人房间
wss://example.com:8443/v4          DG-LAB Socket V4
https://example.com:8443/healthz   健康检查
```

启用 SSL 时，对**同一个 8443 端口**发起的明文 HTTP 会 308 跳转 HTTPS。

这不等于接管：

```text
http://example.com/   -> 80 端口现有项目决定
https://example.com/  -> 443 端口现有项目决定
```

CoyoteLink 不会为了重定向额外监听 80/443。

## 服务端接口

| 路径 | 用途 |
| --- | --- |
| `/` | Web UI |
| `/ws` | 双人房间 WebSocket |
| `/v4` | DG-LAB Socket V4 relay |
| `/healthz` | 运行状态/版本检查 |
| `/api/qr.png?text=...` | 本地 PNG 二维码 |
| `/api/qr.svg?text=...` | 本地 SVG 二维码回退 |

## 项目结构

```text
.
├── index.html                 # 页面结构与样式
├── app.js                     # 前端房间、V4、强度、波形与触摸逻辑
├── server.js                  # HTTP(S)、/ws、/v4、二维码接口
├── tls-scan.js                # 证书/私钥匹配扫描
├── deploy.sh                  # Linux 部署/修复/卸载
├── update.sh                  # Linux 原地更新与回滚
├── deploy.ps1                 # Windows Server 部署
├── vendor/qrcode/             # 随仓库分发的二维码实现及其许可证
├── OFFICIAL_SOCKET.md         # 官方协议/开源依据
├── docs/
│   ├── ARCHITECTURE.md
│   └── WAVEFORM_FORMAT.md
├── CHANGELOG.md
├── SECURITY.md
├── CONTRIBUTING.md
├── NOTICE.md
└── LICENSE                    # GPL-3.0-only
```

## 开发检查

项目不依赖 npm 安装即可运行，二维码实现已放在 `vendor/`。

```bash
node --check app.js
node --check server.js
node --check tls-scan.js
bash -n deploy.sh
bash -n update.sh
PORT=8787 HOST=127.0.0.1 node server.js
```

然后访问：

```text
http://127.0.0.1:8787/healthz
```

## 已知限制

- 没有服务端托管浏览器的 V4 控制会话；浏览器切后台可能被系统节流，因此后台控制不作为支持场景。
- 页面禁止选择/复制/粘贴、缩放和拖动主要用于防误触，不是 DRM；浏览器地址栏、开发者工具、系统截图等无法由网页禁止。
- 不同 DG-LAB APP/固件版本上报的设备属性可能不同；网页会优先使用明确上报值，否则基于实际强度回读进行收敛。
- 实际硬件行为仍应以对应 APP、主机固件和官方协议为准。

## 开源与上游

本项目以 **GPL-3.0-only** 发布。仓库包含/参考 GPL 兼容的 DG-LAB 开源协议与 V4 实现，因此分发修改版时也应保留相应许可证与来源说明。

上游项目包括：

- `dungeonlab-open/dglab-kit`
- `dungeonlab-open/dglab-websocket-server`
- `dungeonlab-open/dglab-bluetooth-protocol`

详见 [NOTICE.md](NOTICE.md) 与 [OFFICIAL_SOCKET.md](OFFICIAL_SOCKET.md)。`vendor/qrcode/` 自带其第三方许可证文件。

## 贡献

Bug、兼容性问题和功能建议欢迎通过 Issues 提交。提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

版本历史见 [CHANGELOG.md](CHANGELOG.md)。当前维护版本为 **v1.0.1**。
