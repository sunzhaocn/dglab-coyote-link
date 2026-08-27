# Official DG-LAB Socket V4 basis

This build replaces Web Bluetooth device access with DG-LAB's official Socket V4 model.

Official upstream sources used as the protocol/runtime basis:

- DG-LAB WebSocket relay server: `dungeonlab-open/dglab-websocket-server`
  - upstream file: `v4-server.ts`
  - protocol role model: controller -> N APP controlled clients
  - `tid` identifies the controller that an APP attaches to
  - upstream license: GPL-3.0
- DG-LAB Toolkit: `dungeonlab-open/dglab-kit`
  - V4 protocol types and RPC behavior
  - `V4Channel.A = 0`, `V4Channel.B = 1`
  - `AppendPulseData = 0`, `AddIntensity = 3`, `SetTempIntensity = 4`, `SetIntensity = 7`
- Official Coyote waveform subset in `app.js` is based on `src/waveform/coyote.ts` from dglab-kit.

Runtime integration in this project:

- `/v4` implements the official V4 relay semantics on the same user-selected web port.
- `/ws` is this project's two-person room relay.
- The browser opens a V4 controller connection, receives `targetId`, and generates the official APP pairing URL:
  `https://dungeon-lab.cn/s/?v=1&action=socket&url=<encoded wss://host:port/v4?tid=targetId>`
- DG-LAB 4 APP scans that QR, connects as the controlled side, and reports devices/slots.
- The room layer never needs browser Bluetooth permissions.

The included `LICENSE-GPL-3.0` applies to the DG-LAB-derived relay/protocol portions. See the upstream repositories for their current source and notices.

## v0.7 失联保护

网页对非零强度优先使用 V4 `SetTempIntensity`（动作类型 4）作为短时可续期任务，并保持绝对强度基线为 0。正常停止仍使用 `SetIntensity`（动作类型 7）归零，并调用 `device.op.clear` 清理任务。这样在浏览器/网络/Socket 突发失联、归零命令无法送达时，临时任务停止续期后仍可自行失效。

## v0.8 强度同步

V4 被控端的 `props.intensityA` / `props.intensityB` 用作设备实际强度反馈。网页对滑块的高频 `input` 事件做短时合并，松手立即发送最终值；若设备上报值没有跟上当前最新目标，最多重发两次相同目标值。安全租约续期始终使用最新目标值，而不是用可能滞后的上报值覆盖目标。



## v0.18 相对强度步进

A/B 按钮每个步进使用官方 V4 `AddIntensity` (`device.op`, `t=3`)：增加 `v=+1`，减少 `v=-1`。连续长按时不设置 `im=true`，避免后续步进替换前一条相对强度任务。松手后再用 `SetTempIntensity` 对最终目标进行安全租约对齐，并通过 `devices.get` 做闭环确认。双人房间使用 `control_delta` 传递每一个相对步进。

## v0.17 通道按钮控制

网页不再用滑块产生强度目标。A/B 每个通道使用一组 Pointer Events `− / ＋` 长按按钮：短按目标值增减 1，长按持续增减，减到 0 或达到当前有效上限即停止。目标值仍通过 v0.15 的 latest-wins 队列与 `devices.get` 闭环回读校验下发。

## v0.19 自定义波形与触摸模式

网页自定义波形仍通过 Socket V4 `device.op` 的 `AppendPulseData (t=0)` 下发。编辑器使用郊狼 V3 原始 100ms 波形块：每个小节为 8 bytes / 16 HEX，前 4 bytes 是 4 个 25ms 频率值，后 4 bytes 是对应波形力度。网页校验频率 `10..240`、力度 `0..100`。

触摸模式不修改协议：根据触摸坐标生成当前 100ms 波形块，并通过 `SetTempIntensity (t=4)` 的短时租约维持通道强度。远程控制时只在网页房间 `/ws` 中转触摸参数，被控端再转换为本机 V4 指令。
