(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const clamp = (n, a, b) => Math.max(a, Math.min(b, Number(n) || 0));
  const nowId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Official dglab-kit coyote waveform data (subset, names mapped to UI labels).
  const WAVES = {
    extrustion: ['0A0A0A0A00000000', '0A0A0A0A64646464'],
    bubble: ['2D2D2D2D00000000', '2D2D2D2D64646464'],
    rhythm: ['0A0A0A0A00000000','0A0A0A0A32323232','0A0A0A0A64646464','0A0A0A0A00000000','0A0A0A0A32323232','0A0A0A0A64646464','1919191964646464','1D1D1D1D64646464','2222222264646464','2626262664646464','2B2B2B2B64646464','0A0A0A0A00000000','0A0A0A0A00000000'],
    air: ['0A0A0A0A64646464','1717171764646464','2424242464646464','3232323264646464','0A0A0A0A00000000','0A0A0A0A64646464','0A0A0A0A00000000','0A0A0A0A64646464','0A0A0A0A00000000','0A0A0A0A64646464','0A0A0A0A00000000','0A0A0A0A64646464','0A0A0A0A00000000'],
    dance: ['0A0A0A0A00000000','0A0A0A0A00000000','0A0A0A0A64646464','0A0A0A0A00000000','0A0A0A0A00000000','0A0A0A0A64646464','0A0A0A0A00000000','0A0A0A0A00000000','0A0A0A0A64646464','0A0A0A0A64646464','0A0A0A0A64646464','0A0A0A0A00000000','0A0A0A0A00000000','0A0A0A0A64646464','0A0A0A0A64646464','0A0A0A0A64646464'],
    climb: ['3030303032323232','282828283C3C3C3C','2020202046464646','1919191950505050','111111115A5A5A5A','0A0A0A0A64646464'],
    shade: ['6464646464646464','6464646464646464'],
    pulse: ['0A0A0A0A64646464','0D0D0D0D64646464','1010101064646464','1313131364646464','1616161664646464','1C1C1C1C64646464','2525252564646464','2E2E2E2E64646464','3737373764646464','4040404064646464','4E4E4E4E64646464','6C6C6C6C64646464','7979797964646464','8686868664646464','9393939364646464','A0A0A0A064646464']
  };

  const ROOM_CODE_RE = /^[A-Z0-9]{8,12}$/;
  // Non-zero output stays fail-safe: the APP receives a temporary intensity task,
  // but we renew it well before expiry. The renewal itself is fire-and-forget;
  // waiting for a long-running device.op response can let the lease hit 0 first.
  const OUTPUT_LEASE_MS = 6000;
  const LEASE_RENEW_MS = 1000;
  const REMOTE_KEEPALIVE_MS = 3500;
  const ROOM_PING_MS = 1000;
  // UI updates immediately, but physical Coyote output is ticked at about 100 ms.
  // Keep only the newest target per channel and pace device writes close to that tick.
  const CONTROL_SEND_INTERVAL_MS = 30;
  const RELATIVE_STEP_INTERVAL_MS = 85;
  const RELATIVE_SETTLE_MS = 260;
  const DEVICE_WRITE_MIN_MS = 85;
  const DEVICE_RETRY_MS = 240;
  // Active read-back verification. A target-changing write is checked against
  // devices.get; only the latest target can be retried and retries are bounded.
  const VERIFY_DELAYS_MS = [180, 320, 600, 1000];
  const VERIFY_WATCHDOG_MS = 1800;
  // Do not infer a fake 199 ceiling from a one-step full-scale reporting mismatch.
  // Soft-ceiling learning is reserved for a meaningful, stable gap.
  const MIN_SATURATION_GAP = 3;
  // When a maximum request settles below the requested value, learn the device/APP
  // effective ceiling only after the reported value has stayed unchanged long enough.
  const MAX_SATURATION_SETTLE_MS = 1000;
  const CUSTOM_WAVE_STORAGE_KEY = 'dglab-custom-waves-v1';
  const MAX_CUSTOM_SECTIONS = 64;
  const TOUCH_SEND_INTERVAL_MS = 95;

  const state = {
    mode: 'remote', roomWs: null, joined: false, room: null, selfId: null, peerId: null,
    peer: { online: false, allow: false, limitA: 20, limitB: 20, deviceMaxA: 200, deviceMaxB: 200, deviceReady: false, deviceName: '', actualA: 0, actualB: 0 },
    local: { allow: false, limitA: 20, limitB: 20, deviceMaxA: 200, deviceMaxB: 200, deviceReady: false, deviceName: '', actualA: 0, actualB: 0, wave: 'extrustion' },
    desired: { A: 0, B: 0, wave: 'extrustion' },
    v4: { enabled: false, ws: null, targetId: null, clientId: null, slotId: null, devices: [], pending: new Map(), pingTimer: null, reconnectTimer: null },
    pulseTimer: null, lastRemoteAt: 0, lastPing: 0, rtt: null,
    controlTimer: null, lastControlSentAt: 0, localTarget: { A:0, B:0, wave:'extrustion', seq:0 },
    retry: { A:{timer:null, seq:0, count:0}, B:{timer:null, seq:0, count:0} },
    verify: {
      A:{timer:null, seq:0, attempt:0, running:false},
      B:{timer:null, seq:0, attempt:0, running:false}
    },
    drive: {
      A:{timer:null, pending:null, lastSent:null, nextAllowedAt:0, inFlight:false},
      B:{timer:null, pending:null, lastSent:null, nextAllowedAt:0, inFlight:false}
    },
    saturation: {
      A:{timer:null, seq:0, actual:null, target:null, samples:0},
      B:{timer:null, seq:0, actual:null, target:null, samples:0}
    },
    relative: { A:{activeUntil:0, leaseTimer:null, direct:false}, B:{activeUntil:0, leaseTimer:null, direct:false} },
    custom: { waves:[], sections:[], applyCh:'AB', selectedId:null },
    waveFrames: { local:{A:null,B:null}, desired:{A:null,B:null} },
    touch: { ch:'A', active:false, pointerId:null, intensity:0, freq:125, power:100, maxPercent:100, lastSentAt:0, timer:null, pending:null, localActive:{A:false,B:false} },
    ui: { deviceConnectExpanded:false }
  };

  function wsBase(path) { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`; }
  function officialSocketUrl() { return state.v4.targetId ? `${wsBase('/v4')}?tid=${encodeURIComponent(state.v4.targetId)}` : ''; }
  function officialShortcutUrl() { const u = officialSocketUrl(); return u ? `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(u)}` : ''; }


  function effectiveLocalMax(channel) {
    const limit = channel === 'A' ? state.local.limitA : state.local.limitB;
    const deviceMax = channel === 'A' ? state.local.deviceMaxA : state.local.deviceMaxB;
    return Math.max(0, Math.min(200, Number(limit) || 0, Number(deviceMax) || 0));
  }

  function effectivePeerMax(channel) {
    const limit = channel === 'A' ? state.peer.limitA : state.peer.limitB;
    const deviceMax = channel === 'A' ? state.peer.deviceMaxA : state.peer.deviceMaxB;
    return Math.max(0, Math.min(200, Number(limit) || 0, Number(deviceMax) || 0));
  }

  function readDeviceMax(device, channel) {
    const slot = device?.slotState || {};
    const props = device?.props || {};
    const node = channel === 'A' ? slot.channelA : slot.channelB;
    // APP versions have exposed channel ceilings in a few slightly different
    // shapes. Prefer an explicit finite value when present, otherwise keep the
    // protocol's absolute 0..200 range and let saturation learning refine it.
    const candidates = channel === 'A'
      ? [node?.intensityMax, slot?.intensityMaxA, props?.intensityMaxA, props?.maxIntensityA, props?.channelA?.intensityMax]
      : [node?.intensityMax, slot?.intensityMaxB, props?.intensityMaxB, props?.maxIntensityB, props?.channelB?.intensityMax];
    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return clamp(Math.round(n), 0, 200);
    }
    return 200;
  }

  function clearSaturation(channel) {
    const s = state.saturation[channel];
    clearTimeout(s.timer);
    s.timer = null; s.seq = 0; s.actual = null; s.target = null; s.samples = 0;
  }

  function scheduleSaturationLearning(channel, actual, target) {
    const s = state.saturation[channel];

    // Only learn a ceiling from a genuine high-end request with a meaningful gap.
    // A 199 report for a 200 target is treated as quantization/reporting noise, not
    // as a permanent 199 ceiling.
    if (!state.local.deviceReady || target < 190 || actual <= 0 || actual >= target || (target - actual) < MIN_SATURATION_GAP) {
      clearTimeout(s.timer);
      s.timer = null;
      s.actual = actual; s.target = target; s.seq = state.localTarget.seq; s.samples = 0;
      return;
    }

    const seq = state.localTarget.seq;
    if (s.seq === seq && s.actual === actual && s.target === target) s.samples += 1;
    else {
      clearTimeout(s.timer);
      s.timer = null;
      s.seq = seq; s.actual = actual; s.target = target; s.samples = 1;
    }

    // Require repeated fresh read-backs before considering a hidden APP/device cap.
    if (s.samples < 3) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      if (!state.local.deviceReady || state.localTarget.seq !== seq) return;
      const currentTarget = Math.min(state.localTarget[channel], effectiveLocalMax(channel));
      const currentActual = state.local['actual'+channel];
      if (currentTarget < 190 || currentActual !== actual || currentActual <= 0 || currentActual >= currentTarget || (currentTarget - currentActual) < MIN_SATURATION_GAP) return;

      const key = 'deviceMax' + channel;
      const learned = clamp(Math.round(currentActual), 0, 200);
      if (learned < state.local[key]) {
        state.local[key] = learned;
        state.localTarget[channel] = Math.min(state.localTarget[channel], learned);
        state.localTarget.seq += 1;
        clearRetry(channel);
        clearVerify(channel);
        queueDeviceIntensity(channel, learned, true);
        sendPresence();
        render();
      }
    }, MAX_SATURATION_SETTLE_MS);
  }

  function setDeviceStatus(text, on = false) {
    $('#socketStateText').textContent = text;
    $('#socketDot').classList.toggle('on', on);
  }

  function renderQr() {
    const shortcut = officialShortcutUrl();
    const socketUrl = officialSocketUrl();
    const waitingForApp = !!shortcut && state.v4.enabled && !state.v4.clientId;
    const show = waitingForApp && state.ui.deviceConnectExpanded;
    const socketBtn = $('#socketBtn');
    $('#qrWrap').classList.toggle('hidden', !show);
    socketBtn.setAttribute('aria-expanded', show ? 'true' : 'false');

    // Keep the connection control available while waiting for the APP so the
    // large QR/manual-address panel can be collapsed on a phone without
    // closing the underlying V4 controller session. Once a device is paired,
    // the panel is no longer needed and the button gets out of the way.
    if (state.v4.clientId) {
      socketBtn.classList.add('hidden');
      socketBtn.disabled = false;
    } else {
      socketBtn.classList.remove('hidden');
      if (!state.v4.enabled) {
        socketBtn.textContent = '连接设备';
        socketBtn.disabled = false;
      } else if (!state.v4.targetId) {
        socketBtn.textContent = '连接中…';
        socketBtn.disabled = true;
      } else {
        socketBtn.textContent = state.ui.deviceConnectExpanded ? '收起连接' : '展开连接';
        socketBtn.disabled = false;
      }
    }

    if (!show) return;
    const img = $('#qrImage');
    const png = `/api/qr.png?text=${encodeURIComponent(shortcut)}`;
    if (img.dataset.qr !== png) {
      img.dataset.qr = png;
      img.dataset.fallback = '0';
      img.src = png;
    }
    $('#openDglab').href = shortcut;
    $('#manualSocketUrl').value = socketUrl;
  }

  $('#qrImage').addEventListener('error', e => {
    const img = e.currentTarget;
    if (img.dataset.fallback === '1') return;
    img.dataset.fallback = '1';
    const shortcut = officialShortcutUrl();
    if (shortcut) img.src = `/api/qr.svg?text=${encodeURIComponent(shortcut)}`;
  });

  function renderMode() {
    let text = '等待连接';
    if (state.joined && state.peer.online) {
      if (state.local.deviceReady && state.peer.deviceReady) text = '双向互控';
      else if (state.peer.deviceReady) text = '单控 · 你控制对方';
      else if (state.local.deviceReady) text = '单控 · 对方控制你';
      else text = '双方暂无设备';
    }
    $('#modeState').textContent = text;
  }

  function render() {
    $('#netDot').classList.toggle('on', !!state.roomWs && state.roomWs.readyState === WebSocket.OPEN);
    $('#peerState').textContent = state.peer.online ? '对方在线' : (state.joined ? '等待对方' : '未连接');
    const joinBtn = $('#joinBtn');
    const leaveBtn = $('#leaveBtn');
    const roomInput = $('#roomCode');
    if (joinBtn) {
      const roomOk = ROOM_CODE_RE.test(String(roomInput?.value || '').trim().toUpperCase());
      joinBtn.classList.toggle('hidden', state.joined);
      joinBtn.disabled = state.joined || !roomOk;
    }
    if (leaveBtn) {
      leaveBtn.disabled = !state.joined;
      leaveBtn.classList.toggle('hidden', !state.joined);
    }
    if (roomInput) roomInput.disabled = state.joined;
    $('#localDeviceName').textContent = state.local.deviceReady ? state.local.deviceName || '已连接' : '未连接';
    $('#localA').textContent = state.local.actualA;
    $('#localB').textContent = state.local.actualB;
    $('#peerDeviceState').textContent = state.peer.deviceReady ? (state.peer.deviceName || '在线') : '无设备';
    $('#remotePermission').textContent = state.peer.allow && state.peer.deviceReady ? '可控制' : state.peer.deviceReady ? '未授权' : '无设备';
    const maxA = state.mode === 'remote' ? effectivePeerMax('A') : effectiveLocalMax('A');
    const maxB = state.mode === 'remote' ? effectivePeerMax('B') : effectiveLocalMax('B');
    if (state.desired.A > maxA) state.desired.A = maxA;
    if (state.desired.B > maxB) state.desired.B = maxB;
    $('#peerLimitA').textContent = maxA;
    $('#peerLimitB').textContent = maxB;
    $('#setA').textContent = state.desired.A;
    $('#setB').textContent = state.desired.B;
    const canControl = state.mode === 'remote'
      ? (state.peer.online && state.peer.deviceReady && state.peer.allow)
      : state.local.deviceReady;
    for (const ch of ['A','B']) {
      const max = ch === 'A' ? maxA : maxB;
      const dec = $('#dec' + ch);
      const inc = $('#inc' + ch);
      if (dec) {
        dec.disabled = !canControl || state.desired[ch] <= 0;
        dec.setAttribute('aria-valuenow', String(state.desired[ch]));
        dec.setAttribute('aria-valuemin', '0');
      }
      if (inc) {
        inc.disabled = !canControl || state.desired[ch] >= max || max <= 0;
        inc.setAttribute('aria-valuenow', String(state.desired[ch]));
        inc.setAttribute('aria-valuemax', String(max));
      }
    }
    $('#controlTitle').textContent = state.mode === 'remote' ? '控制对方设备' : '本机测试';
    $('#controlHint').textContent = state.mode === 'remote'
      ? (!state.peer.online ? '等待对方' : !state.peer.deviceReady ? '对方未连接设备' : !state.peer.allow ? '等待对方授权' : '可控制')
      : (state.local.deviceReady ? '本机设备已连接' : '请先连接设备');
    $('#remotePermission').classList.toggle('hidden', state.mode !== 'remote');
    $$('.wave').forEach(x => x.classList.toggle('active', x.dataset.wave === state.desired.wave && !state.waveFrames.desired.A && !state.waveFrames.desired.B));
    const wbs = $('#waveWorkbenchState');
    if (wbs) wbs.textContent = state.touch.active ? '触摸输出中' : (state.waveFrames.desired.A || state.waveFrames.desired.B ? '自定义波形' : '就绪');
    renderMode();
    renderQr();
  }

  function zeroDesired() {
    state.desired.A = 0;
    state.desired.B = 0;
  }

  function clearRetry(channel) {
    const r = state.retry[channel];
    clearTimeout(r.timer);
    r.timer = null; r.count = 0; r.seq = state.localTarget.seq;
  }

  function clearVerify(channel) {
    const v = state.verify[channel];
    clearTimeout(v.timer);
    v.timer = null;
    v.seq = state.localTarget.seq;
    v.attempt = 0;
    v.running = false;
  }

  function scheduleVerify(channel, reset = false, delay = VERIFY_DELAYS_MS[0]) {
    const v = state.verify[channel];
    if (reset) {
      clearTimeout(v.timer);
      v.timer = null;
      v.seq = state.localTarget.seq;
      v.attempt = 0;
    }
    if (!state.local.deviceReady || state.localTarget[channel] <= 0 || v.running || v.timer) return;
    const seq = state.localTarget.seq;
    v.seq = seq;
    v.timer = setTimeout(() => verifyIntensity(channel, seq), Math.max(80, Number(delay) || 0));
  }

  async function verifyIntensity(channel, seq) {
    const v = state.verify[channel];
    v.timer = null;
    if (v.running || !state.local.deviceReady || state.localTarget.seq !== seq || state.localTarget[channel] <= 0) return;
    const relativeWait = state.relative[channel].activeUntil - Date.now();
    if (relativeWait > 0) {
      scheduleVerify(channel, false, Math.max(80, relativeWait + 40));
      return;
    }
    v.running = true;
    let followupDelay = null;
    try {
      // Ask the APP for a fresh device snapshot instead of trusting a possibly stale
      // slots.patch event. requestDevices() also updates actualA/actualB.
      await requestDevices();
      if (!state.local.deviceReady || state.localTarget.seq !== seq) return;
      const target = Math.round(clamp(state.localTarget[channel], 0, effectiveLocalMax(channel)));
      const actual = Math.round(clamp(state.local['actual' + channel], 0, 200));
      if (target <= 0 || actual === target) {
        v.attempt = 0;
        clearSaturation(channel);
        return;
      }

      // A one-step 199/200 report is not treated as a lower device ceiling. We still
      // retry it, but never permanently shrink the slider because of that one step.
      scheduleSaturationLearning(channel, actual, target);
      if (v.attempt < VERIFY_DELAYS_MS.length) {
        followupDelay = VERIFY_DELAYS_MS[v.attempt];
        v.attempt += 1;
        if (state.relative[channel].direct) {
          const correction = Math.trunc(target - actual);
          if (correction) changeRelativeIntensity(channel, correction).catch(()=>{});
        } else {
          queueDeviceIntensity(channel, target, true);
        }
      } else {
        // Bounded correction prevents a bad/slow link from becoming a command storm.
        // A low-frequency watchdog can try again later if the mismatch persists.
        v.attempt = 0;
        followupDelay = VERIFY_WATCHDOG_MS;
      }
    } catch {
      followupDelay = VERIFY_WATCHDOG_MS;
    } finally {
      v.running = false;
      if (followupDelay !== null && state.local.deviceReady && state.localTarget.seq === seq && state.localTarget[channel] > 0)
        scheduleVerify(channel, false, followupDelay);
    }
  }

  function noteLocalTarget(A, B, wave) {
    const changed = A !== state.localTarget.A || B !== state.localTarget.B || wave !== state.localTarget.wave;
    state.localTarget.A = A; state.localTarget.B = B; state.localTarget.wave = wave;
    if (changed) {
      state.localTarget.seq += 1;
      clearRetry('A'); clearRetry('B');
      clearVerify('A'); clearVerify('B');
      clearSaturation('A'); clearSaturation('B');
    }
  }

  function reconcileReportedIntensity(device) {
    const props = device?.props || {};
    const prevMaxA = state.local.deviceMaxA;
    const prevMaxB = state.local.deviceMaxB;
    const reportedMaxA = readDeviceMax(device, 'A');
    const reportedMaxB = readDeviceMax(device, 'B');
    // Explicit APP ceilings may lower the max immediately. A previously learned
    // ceiling is only raised again if the device later reports an actual value
    // above it (handled below), preventing 200 fallback snapshots from undoing it.
    if (reportedMaxA < 200 || state.local.deviceMaxA === 200) state.local.deviceMaxA = reportedMaxA;
    if (reportedMaxB < 200 || state.local.deviceMaxB === 200) state.local.deviceMaxB = reportedMaxB;

    const vals = { A:Number(props.intensityA), B:Number(props.intensityB) };
    let changed = prevMaxA !== state.local.deviceMaxA || prevMaxB !== state.local.deviceMaxB;
    for (const ch of ['A','B']) {
      if (!Number.isFinite(vals[ch])) continue;
      const actual = clamp(Math.round(vals[ch]), 0, 200);
      if (state.local['actual'+ch] !== actual) { state.local['actual'+ch] = actual; changed = true; }
      const maxKey = 'deviceMax' + ch;
      if (actual > state.local[maxKey]) { state.local[maxKey] = actual; changed = true; }

      const max = effectiveLocalMax(ch);
      if (state.localTarget[ch] > max) {
        state.localTarget[ch] = max;
        state.localTarget.seq += 1;
        if (state.relative[ch].direct) {
          const diff = Math.trunc(max - state.local['actual'+ch]);
          if (diff) changeRelativeIntensity(ch, diff).catch(()=>{});
        } else queueDeviceIntensity(ch, max, true);
      }

      const target = Math.min(state.localTarget[ch], max);
      const r = state.retry[ch];
      if (target <= 0) {
        clearRetry(ch); clearVerify(ch); clearSaturation(ch);
        state.relative[ch].direct = false;
        if (actual > 0) queueDeviceIntensity(ch, 0, true);
        continue;
      }
      if (actual === target) { clearRetry(ch); clearVerify(ch); clearSaturation(ch); continue; }
      if (Date.now() < state.relative[ch].activeUntil) continue;
      scheduleSaturationLearning(ch, actual, target);
      scheduleVerify(ch, false, DEVICE_RETRY_MS);
    }
    if (changed) { sendPresence(); render(); }
  }

  function roomSend(obj) {
    if (state.roomWs?.readyState === WebSocket.OPEN) {
      try { state.roomWs.send(JSON.stringify(obj)); } catch {}
    }
  }

  function sendPresence() {
    roomSend({
      type: 'presence', allow: state.local.allow,
      limitA: state.local.limitA, limitB: state.local.limitB,
      deviceReady: state.local.deviceReady, deviceName: state.local.deviceName,
      deviceMaxA: state.local.deviceMaxA, deviceMaxB: state.local.deviceMaxB,
      actualA: state.local.actualA, actualB: state.local.actualB
    });
  }

  function validateRoomInput(showError = false) {
    const input = $('#roomCode');
    const value = input.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (input.value !== value) input.value = value;
    const ok = ROOM_CODE_RE.test(value);
    $('#joinBtn').disabled = state.joined || !ok;
    const help = $('#roomHelp');
    help.textContent = ok ? '房间号格式正确' : '房间号需 8–12 位，仅限英文字母和数字';
    help.classList.toggle('error', showError && !ok);
    return ok ? value : null;
  }

  function resetPeer() {
    state.peerId = null;
    state.peer = { online:false, allow:false, limitA:20, limitB:20, deviceMaxA:200, deviceMaxB:200, deviceReady:false, deviceName:'', actualA:0, actualB:0 };
  }

  async function emergencyStopLocal(broadcastStop = true) {
    state.touch.active = false;
    state.touch.pointerId = null;
    state.touch.pending = null;
    clearTimeout(state.touch.timer); state.touch.timer = null;
    state.touch.localActive.A = false; state.touch.localActive.B = false;
    zeroDesired();
    state.local.actualA = 0;
    state.local.actualB = 0;
    noteLocalTarget(0, 0, state.local.wave);
    clearDrive('A'); clearDrive('B');
    state.lastRemoteAt = 0;
    try {
      await Promise.all([
        clearOperate('A'), clearOperate('B'),
        setBaselineIntensity('A', 0), setBaselineIntensity('B', 0)
      ]);
    } catch {}
    sendPresence();
    if (broadcastStop) roomSend({ type:'stop' });
    render();
  }

  function handlePeerOffline() {
    resetPeer();
    emergencyStopLocal(false);
    render();
  }

  function leaveRoomClient() {
    if (state.touch.active) endTouchOutput();
    // Tell the peer to stop before severing the room transport. The V4 device
    // connection is separate and intentionally remains paired to this browser.
    try { if (state.joined) roomSend({ type:'stop' }); } catch {}
    const ws = state.roomWs;
    state.roomWs = null;
    state.joined = false;
    state.room = null;
    state.selfId = null;
    state.peerId = null;
    resetPeer();
    zeroDesired();
    try { ws?.close(1000, 'leave room'); } catch {}
    $('#roomHelp').textContent = '已离开房间，本机设备连接保留';
    $('#roomHelp').classList.remove('error');
    render();
  }

  function connectRoom() {
    const room = validateRoomInput(true);
    if (!room) return;
    $('#roomHelp').classList.remove('error');
    if (state.roomWs) try { state.roomWs.close(); } catch {}
    const ws = new WebSocket(wsBase('/ws'));
    state.roomWs = ws;
    state.room = room;
    state.joined = false;
    resetPeer();

    ws.onopen = () => {
      if (state.roomWs !== ws) return;
      ws.send(JSON.stringify({ type: 'join', room }));
      render();
    };
    ws.onmessage = e => {
      if (state.roomWs !== ws) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'joined') {
        state.joined = true;
        state.selfId = m.peerId;
        $('#roomHelp').textContent = `已进入房间 ${m.room}`;
        $('#roomHelp').classList.remove('error');
        sendPresence();
      } else if (m.type === 'peer') {
        if (m.online) {
          state.peer.online = true;
          state.peerId = m.peerId;
          setTimeout(sendPresence, 50);
        } else {
          handlePeerOffline();
        }
      } else if (m.type === 'presence') {
        const lostDevice = state.peer.deviceReady && !m.deviceReady;
        const revoked = state.peer.allow && !m.allow;
        Object.assign(state.peer, {
          online:true, allow:!!m.allow,
          limitA:clamp(m.limitA,0,200), limitB:clamp(m.limitB,0,200),
          deviceMaxA:clamp(m.deviceMaxA ?? 200,0,200), deviceMaxB:clamp(m.deviceMaxB ?? 200,0,200),
          deviceReady:!!m.deviceReady, deviceName:String(m.deviceName||''),
          actualA:clamp(m.actualA,0,200), actualB:clamp(m.actualB,0,200)
        });
        if (lostDevice || revoked) zeroDesired();
        if (state.mode === 'remote') {
          const oldA = state.desired.A, oldB = state.desired.B;
          state.desired.A = Math.min(state.desired.A, effectivePeerMax('A'));
          state.desired.B = Math.min(state.desired.B, effectivePeerMax('B'));
          if ((oldA !== state.desired.A || oldB !== state.desired.B) && state.peer.allow && state.peer.deviceReady) scheduleControlSend(true);
        }
      } else if (m.type === 'control_delta') {
        applyRemoteDelta(m);
      } else if (m.type === 'control') {
        applyRemoteControl(m);
        if (m.commit) finalizeLocalTarget();
      } else if (m.type === 'wave_custom') {
        applyRemoteCustomWave(m);
      } else if (m.type === 'touch_control') {
        applyRemoteTouch(m);
      } else if (m.type === 'stop') {
        emergencyStopLocal(false);
      } else if (m.type === 'pong') {
        state.rtt = Math.max(0, Date.now() - Number(m.ts || Date.now()));
      } else if (m.type === 'error') {
        $('#roomHelp').textContent = m.message || '房间连接失败';
        $('#roomHelp').classList.add('error');
      }
      render();
    };
    ws.onclose = () => {
      if (state.roomWs !== ws) return;
      state.joined = false;
      state.roomWs = null;
      handlePeerOffline();
      $('#roomHelp').textContent = '房间连接已断开';
      $('#roomHelp').classList.add('error');
    };
    ws.onerror = () => {
      if (state.roomWs !== ws) return;
      $('#roomHelp').textContent = '房间连接失败';
      $('#roomHelp').classList.add('error');
    };
  }

  function v4Send(frame) {
    const ws = state.v4.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Socket V4 未连接');
    ws.send(JSON.stringify(frame));
  }

  function v4Request(clientId, method, data, wait = false, timeout = 8000) {
    const reqId = nowId();
    const payload = { t: 'req', reqId, m: method };
    if (data !== undefined) payload.data = data;
    v4Send({ type: 'message', clientId, data: payload });
    if (!wait) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.v4.pending.delete(reqId);
        reject(new Error('等待设备响应超时'));
      }, timeout);
      state.v4.pending.set(reqId, { resolve, reject, timer });
    });
  }

  function clearPendingV4(error = new Error('Socket V4 已断开')) {
    for (const [, p] of state.v4.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    state.v4.pending.clear();
  }


  function mergeSlotState(previous, incoming) {
    if (!incoming) return previous;
    const merged = { ...(previous || {}), ...incoming };
    if (incoming.channelA) merged.channelA = { ...(previous?.channelA || {}), ...incoming.channelA };
    if (incoming.channelB) merged.channelB = { ...(previous?.channelB || {}), ...incoming.channelB };
    return merged;
  }

  function mergeDevice(previous, incoming) {
    if (!previous) return incoming;
    return {
      ...previous,
      ...incoming,
      props: incoming?.props ? { ...(previous.props || {}), ...incoming.props } : previous.props,
      slotState: mergeSlotState(previous.slotState, incoming?.slotState)
    };
  }

  function pickDevice(devices) {
    const incoming = Array.isArray(devices) ? devices : [];
    const previous = new Map(state.v4.devices.map(x => [x.slotId, x]));
    const list = incoming.map(d => mergeDevice(previous.get(d?.slotId), d));
    state.v4.devices = list;
    const d = list.find(x => x?.slotState?.hasDevice !== false) || list[0];
    if (!d) return clearDevice();
    const changed = !state.local.deviceReady || state.v4.slotId !== d.slotId;
    state.v4.slotId = d.slotId;
    state.local.deviceReady = true;
    state.local.deviceName = d.name || d.type || `设备 ${d.slotId}`;
    const pickedMaxA = readDeviceMax(d, 'A');
    const pickedMaxB = readDeviceMax(d, 'B');
    if (changed || pickedMaxA < 200 || state.local.deviceMaxA === 200) state.local.deviceMaxA = pickedMaxA;
    if (changed || pickedMaxB < 200 || state.local.deviceMaxB === 200) state.local.deviceMaxB = pickedMaxB;
    setDeviceStatus('已连接', true);
    if (changed) {
      state.local.actualA = 0;
      state.local.actualB = 0;
      noteLocalTarget(0, 0, state.local.wave);
      Promise.all([
        clearOperate('A'), clearOperate('B'),
        setBaselineIntensity('A',0), setBaselineIntensity('B',0)
      ]).catch(()=>{});
    } else {
      reconcileReportedIntensity(d);
    }
    sendPresence();
    render();
    startPulseLoop();
  }

  function clearDevice() {
    state.v4.slotId = null;
    state.v4.devices = [];
    state.local.deviceReady = false;
    state.local.deviceName = '';
    state.local.deviceMaxA = 200;
    state.local.deviceMaxB = 200;
    state.local.actualA = 0;
    state.local.actualB = 0;
    noteLocalTarget(0, 0, state.local.wave);
    clearRetry('A'); clearRetry('B');
    clearVerify('A'); clearVerify('B');
    clearDrive('A'); clearDrive('B');
    state.touch.active = false; state.touch.pointerId = null; state.touch.pending = null;
    clearTimeout(state.touch.timer); state.touch.timer = null;
    state.touch.localActive.A = false; state.touch.localActive.B = false;
    state.lastRemoteAt = 0;
    setDeviceStatus(state.v4.clientId ? '等待设备' : state.v4.targetId ? '等待扫码' : state.v4.enabled ? '重连中' : '未连接', false);
    sendPresence();
    render();
  }

  function updateDeviceEvents(data) {
    if (!data || typeof data !== 'object') return;
    if (data.t === 'resp') {
      const id = data.reqId || data.requestId;
      const p = state.v4.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        state.v4.pending.delete(id);
        data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
      }
      return;
    }
    if (data.t !== 'ev') return;
    if (data.ev === 'devices.snapshot') return pickDevice(data.devices || []);
    if (data.ev === 'devices.patch') {
      const map = new Map(state.v4.devices.map(x => [x.slotId, x]));
      for (const d of (data.added || [])) map.set(d.slotId, d);
      for (const id of (data.removed || [])) map.delete(id);
      return pickDevice([...map.values()]);
    }
    if (data.ev === 'slots.patch') {
      for (const patch of (data.slots || [])) {
        const d = state.v4.devices.find(x => x.slotId === patch.slotId);
        if (!d) continue;
        if (patch.props) d.props = { ...(d.props || {}), ...patch.props };
        if (patch.slotState) d.slotState = mergeSlotState(d.slotState, patch.slotState);
      }
      return pickDevice(state.v4.devices);
    }
  }

  async function requestDevices() {
    if (!state.v4.clientId) return null;
    try {
      const result = await v4Request(state.v4.clientId, 'devices.get', undefined, true);
      if (result?.devices) pickDevice(result.devices);
      return result || null;
    } catch {
      return null;
    }
  }

  function scheduleV4Reconnect() {
    clearTimeout(state.v4.reconnectTimer);
    if (!state.v4.enabled) return;
    state.v4.reconnectTimer = setTimeout(() => connectOfficialSocket(true), 1000);
  }

  function connectOfficialSocket(isReconnect = false) {
    state.v4.enabled = true;
    clearTimeout(state.v4.reconnectTimer);
    const previous = state.v4.ws;
    if (previous && previous.readyState <= WebSocket.OPEN) {
      try { previous.close(); } catch {}
    }
    state.v4.targetId = null;
    state.v4.clientId = null;
    clearPendingV4();
    clearDevice();
    setDeviceStatus(isReconnect ? '重连中' : '连接中', false);

    const ws = new WebSocket(wsBase('/v4'));
    state.v4.ws = ws;
    ws.onmessage = e => {
      if (state.v4.ws !== ws) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello') {
        state.v4.targetId = m.clientId;
        setDeviceStatus('等待扫码', false);
        renderQr();
      } else if (m.type === 'client_attached') {
        state.v4.clientId = m.clientId;
        setDeviceStatus('读取设备', true);
        renderQr();
        setTimeout(requestDevices, 100);
      } else if (m.type === 'client_disconnected') {
        if (m.clientId === state.v4.clientId) {
          emergencyStopLocal(false);
          state.v4.clientId = null;
          clearDevice();
          setDeviceStatus('等待扫码', false);
          renderQr();
        }
      } else if (m.type === 'message') {
        if (m.clientId === state.v4.clientId) updateDeviceEvents(m.data);
      } else if (m.type === 'idle_timeout') {
        try { ws.close(); } catch {}
      } else if (m.type === 'error') {
        setDeviceStatus('连接异常', false);
      }
      render();
    };
    ws.onclose = () => {
      if (state.v4.ws !== ws) return;
      emergencyStopLocal(false);
      state.v4.ws = null;
      state.v4.targetId = null;
      state.v4.clientId = null;
      clearPendingV4();
      clearDevice();
      setDeviceStatus('重连中', false);
      scheduleV4Reconnect();
    };
    ws.onerror = () => {
      if (state.v4.ws === ws) setDeviceStatus('连接异常', false);
    };

    clearInterval(state.v4.pingTimer);
    state.v4.pingTimer = setInterval(() => {
      if (state.v4.ws?.readyState === WebSocket.OPEN) {
        try { state.v4.ws.send(JSON.stringify({ type:'ping' })); } catch {}
      }
    }, 2000);
  }

  function deviceOperate(channel, actionType, value, duration, wait = false) {
    if (!state.v4.clientId || !state.v4.slotId) return Promise.reject(new Error('设备未接入'));
    const data = { s: state.v4.slotId, c: channel === 'A' ? 0 : 1, t: actionType, im: true };
    if (value !== undefined) data.v = value;
    if (duration !== undefined) data.d = duration;
    return v4Request(state.v4.clientId, 'device.op', data, wait, Math.max(1800, Number(duration || 0) + 500));
  }

  function setBaselineIntensity(channel, value) {
    return deviceOperate(channel, 7, clamp(value, 0, effectiveLocalMax(channel)));
  }

  function setLeasedIntensity(channel, value) {
    value = clamp(value, 0, effectiveLocalMax(channel));
    if (value <= 0) return setBaselineIntensity(channel, 0);
    // Do not wait for the temporary task's RPC response before allowing renewal.
    // Some APP/device paths acknowledge only after (or near) task completion.
    return deviceOperate(channel, 4, value, OUTPUT_LEASE_MS, false);
  }

  function changeRelativeIntensity(channel, delta) {
    if (!state.v4.clientId || !state.v4.slotId) return Promise.reject(new Error('设备未接入'));
    delta = Math.trunc(Number(delta) || 0);
    if (!delta) return Promise.resolve();
    // Official V4 AddIntensity (t=3). Do NOT set im=true here: every +1/-1
    // is an independent relative step and must not replace the preceding step.
    const data = { s: state.v4.slotId, c: channel === 'A' ? 0 : 1, t: 3, v: delta };
    return v4Request(state.v4.clientId, 'device.op', data, false);
  }

  function markRelativeActivity(channel) {
    state.relative[channel].activeUntil = Date.now() + RELATIVE_SETTLE_MS;
    clearVerify(channel);
    clearSaturation(channel);
  }

  function ensureRelativeLease(channel, target, previous) {
    // The first step away from zero immediately establishes a short fail-safe lease.
    // Later steps stay smooth via AddIntensity; the normal 1 s renewal loop keeps
    // the lease aligned with the newest target.
    if (previous !== 0 || target <= 0) return;
    const r = state.relative[channel];
    clearTimeout(r.leaseTimer);
    r.leaseTimer = setTimeout(() => {
      r.leaseTimer = null;
      if (!state.local.deviceReady) return;
      const latest = Math.round(clamp(state.localTarget[channel], 0, effectiveLocalMax(channel)));
      if (latest > 0) setLeasedIntensity(channel, latest).catch(()=>{});
    }, 100);
  }

  function applyLocalDelta(channel, delta, wave = state.localTarget.wave) {
    if (!state.local.deviceReady) return false;
    const max = effectiveLocalMax(channel);
    const previous = Math.round(clamp(state.localTarget[channel], 0, max));
    const next = Math.round(clamp(previous + Math.trunc(Number(delta) || 0), 0, max));
    const applied = next - previous;
    if (!applied) return false;

    const A = channel === 'A' ? next : state.localTarget.A;
    const B = channel === 'B' ? next : state.localTarget.B;
    noteLocalTarget(A, B, WAVES[wave] ? wave : state.localTarget.wave);
    state.relative[channel].direct = true;
    markRelativeActivity(channel);

    const d = state.drive[channel];
    clearTimeout(d.timer);
    d.timer = null;
    d.pending = null;
    d.lastSent = next;
    d.nextAllowedAt = performance.now();

    changeRelativeIntensity(channel, applied).catch(() => {
      // Keep relative-button mode pure: never fall back to SetTempIntensity,
      // because a temporary task can stack with the relative baseline and double output.
      scheduleVerify(channel, true, DEVICE_RETRY_MS);
    });
    if (next === 0) {
      state.relative[channel].direct = false;
      queueDeviceIntensity(channel, 0, true);
    }
    render();
    return true;
  }

  function finalizeLocalTarget(channel = null) {
    const channels = channel ? [channel] : ['A','B'];
    for (const ch of channels) {
      state.relative[ch].activeUntil = 0;
      const target = Math.round(clamp(state.localTarget[ch], 0, effectiveLocalMax(ch)));
      if (target > 0) {
        // Button control stays in pure AddIntensity mode. Do not stack a
        // SetTempIntensity task on top of the relative baseline; just read back
        // the physical value and correct the difference with another relative op.
        scheduleVerify(ch, true, 180);
      } else {
        state.relative[ch].direct = false;
        queueDeviceIntensity(ch, 0, true);
      }
    }
  }

  function validCustomFrames(frames) {
    if (!Array.isArray(frames) || !frames.length || frames.length > MAX_CUSTOM_SECTIONS) return false;
    return frames.every(frame => typeof frame === 'string' && /^[0-9A-Fa-f]{16}$/.test(frame) && (() => {
      const bytes = frame.match(/../g).map(x => parseInt(x, 16));
      return bytes.slice(0,4).every(x => x >= 10 && x <= 240) && bytes.slice(4,8).every(x => x >= 0 && x <= 100);
    })());
  }

  function localWaveFrames(channel) {
    const custom = state.waveFrames.local[channel];
    return custom && validCustomFrames(custom.frames) ? custom.frames : (WAVES[state.local.wave] || WAVES.extrustion);
  }

  function sendPulse(channel) {
    const frames = localWaveFrames(channel);
    const duration = Math.max(1200, Math.min(6500, frames.length * 100));
    return deviceOperate(channel, 0, frames, duration);
  }

  function applyRemoteCustomWave(m) {
    if (!state.peer.online || !state.local.allow || !state.local.deviceReady) return;
    const channels = m.ch === 'A' ? ['A'] : m.ch === 'B' ? ['B'] : ['A','B'];
    const frames = m.clear ? null : (validCustomFrames(m.frames) ? m.frames.map(x => x.toUpperCase()) : null);
    if (!m.clear && !frames) return;
    for (const ch of channels) state.waveFrames.local[ch] = frames ? { id:String(m.id||'remote'), name:String(m.name||'远程自定义').slice(0,32), frames } : null;
    state.lastRemoteAt = Date.now();
    for (const ch of channels) if (state.localTarget[ch] > 0 && !state.touch.localActive[ch]) sendPulse(ch).catch(()=>{});
  }

  function makeTouchFrame(freq, power) {
    freq = Math.round(clamp(freq, 10, 240));
    power = Math.round(clamp(power, 0, 100));
    const hx = n => n.toString(16).padStart(2,'0').toUpperCase();
    return hx(freq).repeat(4) + hx(power).repeat(4);
  }

  function stopLocalTouchChannels(channels) {
    for (const ch of channels) {
      state.touch.localActive[ch] = false;
      const A = ch === 'A' ? 0 : state.localTarget.A;
      const B = ch === 'B' ? 0 : state.localTarget.B;
      noteLocalTarget(A, B, state.localTarget.wave);
      clearOperate(ch).catch(()=>{});
      queueDeviceIntensity(ch, 0, true);
    }
    render();
  }

  function applyTouchToLocal(chName, active, intensity, freq, power) {
    if (!state.local.deviceReady) return;
    const channels = chName === 'AB' ? ['A','B'] : [chName === 'B' ? 'B' : 'A'];
    if (!active) { stopLocalTouchChannels(channels); return; }
    const frame = makeTouchFrame(freq, power);
    for (const ch of channels) {
      const target = Math.round(clamp(intensity, 0, effectiveLocalMax(ch)));
      state.touch.localActive[ch] = true;
      const A = ch === 'A' ? target : state.localTarget.A;
      const B = ch === 'B' ? target : state.localTarget.B;
      noteLocalTarget(A, B, state.localTarget.wave);
      if (target > 0) {
        setLeasedIntensity(ch, target).catch(()=>{});
        deviceOperate(ch, 0, [frame], 450, false).catch(()=>{});
      } else queueDeviceIntensity(ch, 0, true);
    }
    render();
  }

  function applyRemoteTouch(m) {
    if (!state.peer.online || !state.local.allow || !state.local.deviceReady) return;
    state.lastRemoteAt = Date.now();
    const ch = m.ch === 'AB' ? 'AB' : (m.ch === 'B' ? 'B' : 'A');
    applyTouchToLocal(ch, !!m.active, Number(m.intensity)||0, Number(m.freq)||125, Number(m.power)||100);
  }

  function clearOperate(channel) {
    if (!state.v4.clientId || !state.v4.slotId) return Promise.resolve();
    return v4Request(state.v4.clientId, 'device.op.clear', { s: state.v4.slotId, c: channel === 'A' ? 0 : 1 }, false);
  }


  function clearDrive(channel) {
    const d = state.drive[channel];
    clearTimeout(d.timer);
    d.timer = null;
    d.pending = null;
    d.lastSent = null;
    d.nextAllowedAt = 0;
    d.inFlight = false;
    clearVerify(channel);
    clearSaturation(channel);
  }

  function queueDeviceIntensity(channel, value, force = false) {
    const d = state.drive[channel];
    const target = Math.round(clamp(value, 0, effectiveLocalMax(channel)));
    d.pending = target;
    if (force) d.lastSent = null;

    if (target === 0) {
      state.relative[channel].direct = false;
      clearTimeout(d.timer);
      d.timer = null;
      d.pending = null;
      d.lastSent = 0;
      d.nextAllowedAt = performance.now();
      clearSaturation(channel);
      Promise.all([clearOperate(channel), setBaselineIntensity(channel, 0)]).catch(()=>{});
      return;
    }

    const flush = async () => {
      d.timer = null;
      if (!state.local.deviceReady || d.pending === null || d.inFlight) return;
      const latest = Math.round(clamp(d.pending, 0, effectiveLocalMax(channel)));
      d.pending = null;
      if (!force && latest === d.lastSent) return;
      d.lastSent = latest;
      d.inFlight = true;
      d.nextAllowedAt = performance.now() + DEVICE_WRITE_MIN_MS;
      try {
        await setLeasedIntensity(channel, latest);
      } catch {
        // Keep only the newest requested target; never replay a backlog.
        if (state.local.deviceReady && state.localTarget[channel] > 0)
          d.pending = Math.round(clamp(state.localTarget[channel], 0, effectiveLocalMax(channel)));
      } finally {
        d.inFlight = false;
        const newest = Math.round(clamp(state.localTarget[channel], 0, effectiveLocalMax(channel)));
        if (d.pending === null && newest !== d.lastSent) d.pending = newest;
        if (d.pending !== null && state.local.deviceReady) {
          const wait = Math.max(0, d.nextAllowedAt - performance.now());
          if (!d.timer) d.timer = setTimeout(flush, wait);
        }
      }
    };

    if (d.inFlight) return;
    const wait = Math.max(0, d.nextAllowedAt - performance.now());
    if (wait <= 0 && !d.timer) { flush(); return; }
    if (!d.timer) d.timer = setTimeout(flush, wait);
  }

  async function applyLocalTarget(A, B, wave = state.desired.wave) {
    if (!state.local.deviceReady) return;
    A = Math.round(clamp(A, 0, effectiveLocalMax('A')));
    B = Math.round(clamp(B, 0, effectiveLocalMax('B')));
    state.local.wave = WAVES[wave] ? wave : 'extrustion';
    const oldA = state.localTarget.A;
    const oldB = state.localTarget.B;
    noteLocalTarget(A, B, state.local.wave);

    if (A !== oldA) {
      queueDeviceIntensity('A', A, A === 0);
      if (A > 0) scheduleVerify('A', true);
    }
    if (B !== oldB) {
      queueDeviceIntensity('B', B, B === 0);
      if (B > 0) scheduleVerify('B', true);
    }
    render();
  }

  function renewLeasedIntensity(channel) {
    if (!state.local.deviceReady) return;
    const target = Math.round(clamp(state.localTarget[channel], 0, effectiveLocalMax(channel)));
    if (target <= 0) return;
    // Renewal bypasses the change queue on purpose. It refreshes the existing
    // temporary task without changing the UI target or replaying intermediate values.
    setLeasedIntensity(channel, target).catch(()=>{});
  }

  function startPulseLoop() {
    clearInterval(state.pulseTimer);
    state.pulseTimer = setInterval(() => {
      if (!state.local.deviceReady) return;
      if (state.localTarget.A > 0 && !state.touch.localActive.A) {
        if (!state.relative.A.direct) renewLeasedIntensity('A');
        sendPulse('A').catch(()=>{});
      }
      if (state.localTarget.B > 0 && !state.touch.localActive.B) {
        if (!state.relative.B.direct) renewLeasedIntensity('B');
        sendPulse('B').catch(()=>{});
      }
    }, LEASE_RENEW_MS);
  }

  function applyRemoteDelta(m) {
    if (!state.peer.online || !state.local.allow || !state.local.deviceReady) return;
    const channel = m.ch === 'B' ? 'B' : 'A';
    const delta = Math.max(-1, Math.min(1, Math.trunc(Number(m.delta) || 0)));
    if (!delta) return;
    state.lastRemoteAt = Date.now();
    const wave = WAVES[m.wave] ? m.wave : state.local.wave;
    applyLocalDelta(channel, delta, wave);
  }

  function applyRemoteControl(m) {
    if (!state.peer.online || !state.local.allow || !state.local.deviceReady) return;
    state.lastRemoteAt = Date.now();
    const A = clamp(m.A, 0, effectiveLocalMax('A'));
    const B = clamp(m.B, 0, effectiveLocalMax('B'));
    const wave = WAVES[m.wave] ? m.wave : 'extrustion';
    applyLocalTarget(A, B, wave);
  }

  function sendControlNow() {
    clearTimeout(state.controlTimer);
    state.controlTimer = null;
    state.lastControlSentAt = performance.now();
    state.desired.A = Math.round(state.desired.A);
    state.desired.B = Math.round(state.desired.B);
    if (state.mode === 'local') return applyLocalTarget(state.desired.A, state.desired.B, state.desired.wave);
    if (!state.peer.online || !state.peer.deviceReady || !state.peer.allow) return;
    const A = Math.round(clamp(state.desired.A, 0, effectivePeerMax('A')));
    const B = Math.round(clamp(state.desired.B, 0, effectivePeerMax('B')));
    roomSend({ type:'control', A, B, wave:state.desired.wave, ts:Date.now() });
  }

  // Throttle + latest-value coalescing: the UI updates immediately while the
  // network sends at most once per interval and always keeps the newest target.
  function scheduleControlSend(immediate = false) {
    if (immediate) return sendControlNow();
    const elapsed = performance.now() - state.lastControlSentAt;
    if (elapsed >= CONTROL_SEND_INTERVAL_MS && !state.controlTimer) return sendControlNow();
    if (state.controlTimer) return;
    const wait = Math.max(0, CONTROL_SEND_INTERVAL_MS - elapsed);
    state.controlTimer = setTimeout(sendControlNow, wait);
  }

  function defaultWaveSection() {
    return { freq:[10,10,10,10], power:[0,33,66,100] };
  }

  function normalizeSection(section) {
    const freq = Array.isArray(section?.freq) ? section.freq : [];
    const power = Array.isArray(section?.power) ? section.power : (Array.isArray(section?.strength) ? section.strength : []);
    if (freq.length !== 4 || power.length !== 4) throw new Error('每个小节必须包含 4 个频率和 4 个力度值');
    return {
      freq: freq.map(v => Math.round(clamp(v,10,240))),
      power: power.map(v => Math.round(clamp(v,0,100)))
    };
  }

  function sectionToFrame(section) {
    const s = normalizeSection(section);
    const hx = n => n.toString(16).padStart(2,'0').toUpperCase();
    return [...s.freq, ...s.power].map(hx).join('');
  }

  function frameToSection(frame) {
    frame = String(frame||'').trim().replace(/^0x/i,'').toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(frame)) throw new Error('波形小节必须是 16 位 HEX');
    const b = frame.match(/../g).map(x=>parseInt(x,16));
    if (!b.slice(0,4).every(x=>x>=10&&x<=240)) throw new Error('频率必须在 10–240');
    if (!b.slice(4,8).every(x=>x>=0&&x<=100)) throw new Error('波形力度必须在 0–100');
    return {freq:b.slice(0,4), power:b.slice(4,8)};
  }

  function parseImportedWave(text, filename='导入波形') {
    let name = filename.replace(/\.[^.]+$/,'').slice(0,32) || '导入波形';
    let frames = null;
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) frames = data;
      else if (data && typeof data === 'object') {
        if (data.name) name = String(data.name).slice(0,32);
        if (Array.isArray(data.frames)) frames = data.frames;
        else if (Array.isArray(data.sections)) frames = data.sections.map(sectionToFrame);
      }
    } catch {}
    if (!frames) frames = text.split(/[\r\n,;\s]+/).map(x=>x.trim()).filter(Boolean);
    if (!frames.length || frames.length > MAX_CUSTOM_SECTIONS) throw new Error(`波形需 1–${MAX_CUSTOM_SECTIONS} 个小节`);
    const sections = frames.map(frameToSection);
    return { id: nowId(), name, frames:sections.map(sectionToFrame), sections };
  }

  function loadCustomWaves() {
    try {
      const data = JSON.parse(localStorage.getItem(CUSTOM_WAVE_STORAGE_KEY) || '[]');
      state.custom.waves = Array.isArray(data) ? data.filter(w => w && typeof w.id==='string' && typeof w.name==='string' && validCustomFrames(w.frames)).slice(0,20) : [];
    } catch { state.custom.waves = []; }
    if (!state.custom.sections.length) state.custom.sections = [defaultWaveSection()];
  }

  function persistCustomWaves() {
    try { localStorage.setItem(CUSTOM_WAVE_STORAGE_KEY, JSON.stringify(state.custom.waves.slice(0,20))); } catch {}
  }

  function editorStatus(text, error=false) {
    const el=$('#waveEditorStatus'); if (!el) return; el.textContent=text||''; el.style.color=error?'#ff8d86':'';
  }

  function renderWaveSections() {
    const root=$('#waveSections'); if (!root) return;
    root.innerHTML='';
    state.custom.sections.forEach((section,index)=>{
      const box=document.createElement('div'); box.className='wave-section';
      const head=document.createElement('div'); head.className='wave-section-head';
      head.innerHTML=`<b>小节 ${index+1} · 100ms</b><div><button class="mini-btn" data-move="up">↑</button> <button class="mini-btn" data-move="down">↓</button> <button class="mini-btn" data-remove>删除</button></div>`;
      const grid=document.createElement('div'); grid.className='point-grid';
      for(let i=0;i<4;i++){
        const pt=document.createElement('div'); pt.className='point';
        pt.innerHTML=`<label>${i*25}ms 频率</label><input data-kind="freq" data-i="${i}" type="number" min="10" max="240" value="${section.freq[i]}"><label style="margin-top:5px">力度</label><input data-kind="power" data-i="${i}" type="number" min="0" max="100" value="${section.power[i]}">`;
        grid.appendChild(pt);
      }
      box.append(head,grid); root.appendChild(box);
      box.querySelectorAll('input').forEach(inp=>inp.addEventListener('change',()=>{
        const i=Number(inp.dataset.i); const kind=inp.dataset.kind; const lo=kind==='freq'?10:0, hi=kind==='freq'?240:100;
        section[kind][i]=Math.round(clamp(inp.value,lo,hi)); inp.value=section[kind][i]; editorStatus('');
      }));
      head.querySelector('[data-remove]').addEventListener('click',()=>{ if(state.custom.sections.length<=1) return; state.custom.sections.splice(index,1); renderWaveSections(); });
      head.querySelector('[data-move="up"]').addEventListener('click',()=>{ if(index<=0)return; [state.custom.sections[index-1],state.custom.sections[index]]=[state.custom.sections[index],state.custom.sections[index-1]]; renderWaveSections(); });
      head.querySelector('[data-move="down"]').addEventListener('click',()=>{ if(index>=state.custom.sections.length-1)return; [state.custom.sections[index+1],state.custom.sections[index]]=[state.custom.sections[index],state.custom.sections[index+1]]; renderWaveSections(); });
    });
  }

  function renderSavedWaves() {
    const root=$('#savedWaves'); if(!root)return; root.innerHTML='';
    if(!state.custom.waves.length){ root.innerHTML='<div class="muted tiny">暂无自定义波形，导入文件或在编辑器中添加小节。</div>'; return; }
    for(const wave of state.custom.waves){
      const row=document.createElement('div'); row.className='saved-wave';
      row.innerHTML=`<div><strong></strong><small></small></div><button class="mini-btn" data-use>应用</button><button class="mini-btn" data-del>删除</button>`;
      row.querySelector('strong').textContent=wave.name; row.querySelector('small').textContent=`${wave.frames.length} 小节 · ${(wave.frames.length/10).toFixed(1)} 秒`;
      row.querySelector('[data-use]').addEventListener('click',()=>applyCustomWave(wave));
      row.querySelector('[data-del]').addEventListener('click',()=>{ state.custom.waves=state.custom.waves.filter(x=>x.id!==wave.id); persistCustomWaves(); renderSavedWaves(); });
      root.appendChild(row);
    }
  }

  function currentEditorWave() {
    const name=String($('#customWaveName')?.value||'我的波形').trim().slice(0,32)||'我的波形';
    if(!state.custom.sections.length || state.custom.sections.length>MAX_CUSTOM_SECTIONS) throw new Error(`波形需 1–${MAX_CUSTOM_SECTIONS} 个小节`);
    const sections=state.custom.sections.map(normalizeSection); return {id:nowId(),name,sections,frames:sections.map(sectionToFrame)};
  }

  function applyCustomWave(wave) {
    if(!wave || !validCustomFrames(wave.frames)) return;
    const channels=state.custom.applyCh==='A'?['A']:state.custom.applyCh==='B'?['B']:['A','B'];
    for(const ch of channels) state.waveFrames.desired[ch]={id:wave.id,name:wave.name,frames:wave.frames.slice()};
    if(state.mode==='local'){
      for(const ch of channels) state.waveFrames.local[ch]={id:wave.id,name:wave.name,frames:wave.frames.slice()};
      for(const ch of channels) if(state.localTarget[ch]>0 && !state.touch.localActive[ch]) sendPulse(ch).catch(()=>{});
    } else if(state.peer.online && state.peer.deviceReady && state.peer.allow) {
      roomSend({type:'wave_custom',ch:state.custom.applyCh,id:wave.id,name:wave.name,frames:wave.frames,ts:Date.now()});
    }
    state.custom.selectedId=wave.id; $('#waveWorkbenchState').textContent=`${wave.name} · ${state.custom.applyCh}`; render();
  }

  function clearDesiredCustomWaves() {
    state.waveFrames.desired.A=null; state.waveFrames.desired.B=null;
    if(state.mode==='local'){ state.waveFrames.local.A=null; state.waveFrames.local.B=null; }
    else if(state.peer.online) roomSend({type:'wave_custom',ch:'AB',clear:true,ts:Date.now()});
  }

  function exportWave(wave) {
    if(!wave || !validCustomFrames(wave.frames)) return;
    const payload={format:'dglab-web-wave-v1',name:wave.name,frames:wave.frames,sections:wave.frames.map(frameToSection)};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download=`${String(wave.name||'wave').replace(/[\\/:*?"<>|]/g,'_')}.json`; a.style.display='none'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),500);
  }

  function touchChannelsFor(chName = state.touch.ch) {
    return chName === 'AB' ? ['A','B'] : [chName === 'B' ? 'B' : 'A'];
  }

  function touchChannels() { return touchChannelsFor(state.touch.ch); }

  function touchValuesFromEvent(e) {
    const pad=$('#touchPad'), r=pad.getBoundingClientRect();
    const x=clamp((e.clientX-r.left)/Math.max(1,r.width),0,1), y=clamp((e.clientY-r.top)/Math.max(1,r.height),0,1);
    const freq=Math.round(10+x*230), pct=1-y;
    const channels=touchChannels();
    const limits=channels.map(ch=>state.mode==='remote'?effectivePeerMax(ch):effectiveLocalMax(ch));
    const base=Math.min(...limits,200)*clamp(state.touch.maxPercent,1,100)/100;
    const intensity=Math.round(clamp(pct*base,0,200));
    return {x,y,freq,intensity,power:Math.round(clamp(state.touch.power,0,100))};
  }

  function renderTouchPoint(v) {
    $('#touchDot').style.left=`${Math.round(v.x*100)}%`; $('#touchDot').style.top=`${Math.round(v.y*100)}%`;
    $('#touchIntensity').textContent=v.intensity; $('#touchFreq').textContent=v.freq; $('#touchPowerView').textContent=v.power;
  }

  function sendTouchPayload(force=false) {
    if(!state.touch.active && !force) return;
    const p=state.touch.pending; if(!p && !force)return;
    const data=p||{intensity:0,freq:state.touch.freq,power:state.touch.power}; state.touch.pending=null; state.touch.lastSentAt=performance.now();
    if(state.mode==='local') applyTouchToLocal(state.touch.ch,state.touch.active,data.intensity,data.freq,data.power);
    else if(state.peer.online&&state.peer.deviceReady&&state.peer.allow) roomSend({type:'touch_control',ch:state.touch.ch,active:state.touch.active,intensity:data.intensity,freq:data.freq,power:data.power,ts:Date.now()});
  }

  function scheduleTouchPayload(v) {
    state.touch.pending=v; const elapsed=performance.now()-state.touch.lastSentAt;
    if(elapsed>=TOUCH_SEND_INTERVAL_MS && !state.touch.timer){sendTouchPayload();return;}
    if(!state.touch.timer) state.touch.timer=setTimeout(()=>{state.touch.timer=null;sendTouchPayload();},Math.max(0,TOUCH_SEND_INTERVAL_MS-elapsed));
  }

  function endTouchOutput(options = {}) {
    const chName = options.ch || state.touch.ch;
    const channels = touchChannelsFor(chName);
    const wasActive = state.touch.active;
    const pointerId = state.touch.pointerId;

    // Clear the logical session BEFORE releasing pointer capture. Some mobile
    // browsers dispatch lostpointercapture asynchronously; clearing first means
    // that stale event cannot terminate a later touch session after a channel switch.
    state.touch.active = false;
    state.touch.pointerId = null;
    state.touch.pending = null;
    clearTimeout(state.touch.timer); state.touch.timer = null;
    state.touch.lastSentAt = 0;

    if (wasActive || options.forceStop) {
      for (const ch of channels) state.desired[ch] = 0;
      if (state.mode === 'local') stopLocalTouchChannels(channels);
      else if (state.peer.online) roomSend({type:'touch_control',ch:chName,active:false,intensity:0,freq:state.touch.freq,power:state.touch.power,ts:Date.now()});
    }

    if (pointerId !== null && options.releaseCapture !== false) {
      const pad = $('#touchPad');
      try {
        if (!pad.hasPointerCapture || pad.hasPointerCapture(pointerId)) pad.releasePointerCapture(pointerId);
      } catch {}
    }

    state.touch.intensity = 0;
    $('#touchIntensity').textContent='0';
    render();
  }

  function switchTouchChannel(nextCh) {
    nextCh = nextCh === 'AB' ? 'AB' : (nextCh === 'B' ? 'B' : 'A');
    if (nextCh === state.touch.ch && !state.touch.active && state.touch.pointerId === null) return;
    const previousCh = state.touch.ch;

    // Always terminate the previous channel session, even if the browser left a
    // stale pointerId behind. This also clears localActive for the old channel(s).
    const previousChannels = touchChannelsFor(previousCh);
    const mustStopPrevious = state.touch.active || state.touch.pointerId !== null || previousChannels.some(ch => state.touch.localActive[ch]);
    endTouchOutput({ ch: previousCh, forceStop: mustStopPrevious });
    state.touch.ch = nextCh;
    state.touch.pending = null;
    state.touch.timer = null;
    state.touch.lastSentAt = 0;
    state.touch.intensity = 0;
    $$('#touchChannel button').forEach(x=>x.classList.toggle('active',x.dataset.touchCh===nextCh));
    $('#touchIntensity').textContent='0';
    render();
  }

  $('#roomCode').addEventListener('input', () => validateRoomInput(false));
  $('#leaveBtn').addEventListener('click', leaveRoomClient);
  $('#roomCode').addEventListener('keydown', e => {
    if (e.key === 'Enter' && validateRoomInput(true)) connectRoom();
  });
  $('#joinBtn').addEventListener('click', connectRoom);
  $('#socketBtn').addEventListener('click', () => {
    if (!state.v4.enabled) {
      state.ui.deviceConnectExpanded = true;
      connectOfficialSocket(false);
      return;
    }
    if (state.v4.clientId || !state.v4.targetId) return;
    state.ui.deviceConnectExpanded = !state.ui.deviceConnectExpanded;
    renderQr();
  });
  let allowProgrammaticCopy = false;
  $('#copySocketUrl').addEventListener('click', async () => {
    const value = $('#manualSocketUrl').value;
    if (!value) return;
    try { await navigator.clipboard.writeText(value); }
    catch {
      allowProgrammaticCopy = true;
      try {
        $('#manualSocketUrl').focus();
        $('#manualSocketUrl').select();
        document.execCommand('copy');
      } finally {
        allowProgrammaticCopy = false;
        $('#manualSocketUrl').blur();
      }
    }
    const b = $('#copySocketUrl'); const old = b.textContent; b.textContent = '已复制';
    setTimeout(() => { b.textContent = old; }, 900);
  });
  $('#allowRemote').addEventListener('change', e => {
    state.local.allow = e.target.checked;
    if (!state.local.allow) emergencyStopLocal(false);
    sendPresence();
    render();
  });
  $('#limitA').addEventListener('change', e => {
    state.local.limitA = clamp(e.target.value,0,200);
    e.target.value = state.local.limitA;
    if (state.localTarget.A > effectiveLocalMax('A')) applyLocalTarget(effectiveLocalMax('A'), state.localTarget.B);
    sendPresence();
    render();
  });
  $('#limitB').addEventListener('change', e => {
    state.local.limitB = clamp(e.target.value,0,200);
    e.target.value = state.local.limitB;
    if (state.localTarget.B > effectiveLocalMax('B')) applyLocalTarget(state.localTarget.A, effectiveLocalMax('B'));
    sendPresence();
    render();
  });
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    if (state.mode === 'remote' && (state.desired.A || state.desired.B)) roomSend({ type:'control', A:0, B:0, wave:state.desired.wave, ts:Date.now() });
    if (state.mode === 'local' && (state.local.actualA || state.local.actualB)) emergencyStopLocal(false);
    state.mode = t.dataset.tab;
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    zeroDesired();
    render();
  }));
  function canAdjustDesired() {
    return state.mode === 'remote'
      ? (state.peer.online && state.peer.deviceReady && state.peer.allow)
      : state.local.deviceReady;
  }

  function incrementDesiredChannel(ch, amount = 1) {
    if (!canAdjustDesired()) return false;
    const max = state.mode === 'remote' ? effectivePeerMax(ch) : effectiveLocalMax(ch);
    const current = Math.round(clamp(state.desired[ch], 0, max));
    const next = Math.round(clamp(current + amount, 0, max));
    if (next === current) return false;
    const delta = next - current;
    state.desired[ch] = next;
    render();

    if (state.mode === 'local') {
      applyLocalDelta(ch, delta, state.desired.wave);
    } else {
      roomSend({ type:'control_delta', ch, delta, wave:state.desired.wave, ts:Date.now() });
    }
    return true;
  }

  function commitDesiredChannel(ch) {
    if (state.mode === 'local') {
      finalizeLocalTarget(ch);
      return;
    }
    if (!state.peer.online || !state.peer.deviceReady || !state.peer.allow) return;
    const A = Math.round(clamp(state.desired.A, 0, effectivePeerMax('A')));
    const B = Math.round(clamp(state.desired.B, 0, effectivePeerMax('B')));
    roomSend({ type:'control', A, B, wave:state.desired.wave, commit:true, ts:Date.now() });
  }

  $$('.hold-step').forEach(button => {
    const ch = button.dataset.ch;
    const dir = Number(button.dataset.dir) < 0 ? -1 : 1;
    let pointerId = null;
    let longTimer = null;
    let repeatTimer = null;
    let longStarted = false;

    const clearPress = () => {
      clearTimeout(longTimer);
      clearInterval(repeatTimer);
      longTimer = null;
      repeatTimer = null;
      button.classList.remove('holding');
    };

    const finish = e => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      e.preventDefault();
      const wasLong = longStarted;
      try { button.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
      clearPress();
      if (!wasLong) incrementDesiredChannel(ch, dir);
      commitDesiredChannel(ch);
      longStarted = false;
    };

    button.addEventListener('pointerdown', e => {
      if (button.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      const active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === 'function') active.blur();
      pointerId = e.pointerId;
      longStarted = false;
      button.classList.add('holding');
      try { button.setPointerCapture(pointerId); } catch {}
      longTimer = setTimeout(() => {
        if (pointerId === null) return;
        longStarted = true;
        incrementDesiredChannel(ch, dir);
        repeatTimer = setInterval(() => {
          if (!incrementDesiredChannel(ch, dir)) {
            clearInterval(repeatTimer);
            repeatTimer = null;
          }
        }, RELATIVE_STEP_INTERVAL_MS);
      }, 280);
    });

    button.addEventListener('pointerup', finish);
    button.addEventListener('pointercancel', e => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      pointerId = null;
      clearPress();
      longStarted = false;
      commitDesiredChannel(ch);
    });
    button.addEventListener('lostpointercapture', () => {
      if (pointerId !== null) {
        pointerId = null;
        clearPress();
        longStarted = false;
        commitDesiredChannel(ch);
      }
    });
    button.addEventListener('contextmenu', e => e.preventDefault());
    button.addEventListener('dragstart', e => e.preventDefault());
  });

  // Kiosk-like interaction guards. Block user-initiated clipboard operations,
  // selection, long-press context menus and dragging at capture phase so child
  // controls cannot re-enable them accidentally. The dedicated "复制地址"
  // action remains available through navigator.clipboard / guarded execCommand.
  const blockPageAction = e => {
    if (allowProgrammaticCopy && e.type === 'copy') return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of ['copy','cut','paste','selectstart','dragstart','contextmenu']) {
    document.addEventListener(type, blockPageAction, { capture:true });
  }
  document.addEventListener('beforeinput', e => {
    if (['insertFromPaste','insertFromDrop','deleteByCut'].includes(e.inputType)) blockPageAction(e);
  }, { capture:true });
  document.addEventListener('selectionchange', () => {
    if (allowProgrammaticCopy) return;
    try { window.getSelection()?.removeAllRanges(); } catch {}
  });
  document.addEventListener('dblclick', e => e.preventDefault(), { passive:false, capture:true });
  document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive:false, capture:true });
  document.addEventListener('keydown', e => {
    const key = String(e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['c','x','v','a','+','-','=','0'].includes(key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Legacy clipboard shortcuts used by some desktop browsers.
    if ((e.shiftKey && key === 'insert') || (e.ctrlKey && key === 'insert')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { capture:true });
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive:false, capture:true });
  document.addEventListener('gesturechange', e => e.preventDefault(), { passive:false, capture:true });
  document.addEventListener('gestureend', e => e.preventDefault(), { passive:false, capture:true });
  document.addEventListener('touchstart', e => {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive:false, capture:true });
  document.addEventListener('touchmove', e => {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive:false, capture:true });
  $$('.qr img, img').forEach(img => img.setAttribute('draggable', 'false'));
  $$('.wave').forEach(w => w.addEventListener('click', () => {
    clearDesiredCustomWaves();
    state.desired.wave = w.dataset.wave;
    if (state.mode === 'local') state.local.wave = w.dataset.wave;
    render();
    scheduleControlSend(true);
  }));
  $('#estop').addEventListener('click', () => emergencyStopLocal(true));

  setInterval(() => {
    if (state.roomWs?.readyState === WebSocket.OPEN) {
      const ts = Date.now();
      state.lastPing = ts;
      roomSend({type:'ping', ts});
      if (state.mode === 'remote' && state.peer.online && state.peer.deviceReady && state.peer.allow) {
        if (state.touch.active) sendTouchPayload(true);
        else if (state.desired.A > 0 || state.desired.B > 0) sendControlNow();
      }
    }
    if (state.local.allow && state.local.deviceReady && state.lastRemoteAt && Date.now() - state.lastRemoteAt > REMOTE_KEEPALIVE_MS && state.local.actualA + state.local.actualB > 0) {
      emergencyStopLocal(false);
    }
    // Low-rate closed-loop watchdog. It only wakes a verifier when a non-zero
    // target and the latest reported physical intensity differ.
    if (state.local.deviceReady) {
      for (const ch of ['A','B']) {
        const target = Math.round(clamp(state.localTarget[ch], 0, effectiveLocalMax(ch)));
        const actual = Math.round(clamp(state.local['actual' + ch], 0, 200));
        if (target > 0 && actual !== target && Date.now() >= state.relative[ch].activeUntil) scheduleVerify(ch, false, VERIFY_WATCHDOG_MS);
      }
    }
  }, ROOM_PING_MS);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (state.touch.active) endTouchOutput();
    if (state.desired.A || state.desired.B || state.local.actualA || state.local.actualB) emergencyStopLocal(true);
  });

  window.addEventListener('beforeunload', () => {
    try { roomSend({ type:'stop' }); } catch {}
    try {
      if (state.local.deviceReady) {
        setBaselineIntensity('A',0);
        setBaselineIntensity('B',0);
      }
    } catch {}
  });

  // Wave workbench UI
  loadCustomWaves();
  renderWaveSections();
  renderSavedWaves();
  $$('.subtab').forEach(btn=>btn.addEventListener('click',()=>{
    if (btn.dataset.waveTab !== 'touch' && (state.touch.active || state.touch.pointerId !== null)) endTouchOutput();
    $$('.subtab').forEach(x=>x.classList.toggle('active',x===btn));
    $$('[data-wave-panel]').forEach(p=>p.classList.toggle('active',p.dataset.wavePanel===btn.dataset.waveTab));
  }));
  $$('#customApplyChannel button').forEach(btn=>btn.addEventListener('click',()=>{
    state.custom.applyCh=btn.dataset.customCh; $$('#customApplyChannel button').forEach(x=>x.classList.toggle('active',x===btn));
  }));
  $('#addWaveSection').addEventListener('click',()=>{ if(state.custom.sections.length>=MAX_CUSTOM_SECTIONS){editorStatus(`最多 ${MAX_CUSTOM_SECTIONS} 个小节`,true);return;} state.custom.sections.push(defaultWaveSection()); renderWaveSections(); });
  $('#clearWaveSections').addEventListener('click',()=>{ state.custom.sections=[defaultWaveSection()]; renderWaveSections(); editorStatus('已重建 1 个小节'); });
  $('#saveCustomWave').addEventListener('click',()=>{ try{const wave=currentEditorWave(); state.custom.waves.unshift({id:wave.id,name:wave.name,frames:wave.frames}); state.custom.waves=state.custom.waves.slice(0,20); persistCustomWaves(); renderSavedWaves(); state.custom.selectedId=wave.id; editorStatus(`已保存：${wave.name}（${wave.frames.length} 小节）`);}catch(e){editorStatus(e.message||'保存失败',true);} });
  $('#waveImport').addEventListener('change',async e=>{ const file=e.target.files?.[0]; if(!file)return; try{const parsed=parseImportedWave(await file.text(),file.name); state.custom.sections=parsed.sections; $('#customWaveName').value=parsed.name; state.custom.waves.unshift({id:parsed.id,name:parsed.name,frames:parsed.frames}); state.custom.waves=state.custom.waves.slice(0,20); persistCustomWaves(); renderWaveSections(); renderSavedWaves(); editorStatus(`已导入 ${parsed.frames.length} 个小节`); $$('.subtab').forEach(x=>x.classList.toggle('active',x.dataset.waveTab==='editor')); $$('[data-wave-panel]').forEach(p=>p.classList.toggle('active',p.dataset.wavePanel==='editor'));}catch(err){editorStatus(err.message||'导入失败',true);} finally{e.target.value='';} });
  $('#waveExportCurrent').addEventListener('click',()=>{ let wave=state.custom.waves.find(x=>x.id===state.custom.selectedId); if(!wave){try{wave=currentEditorWave();}catch(e){editorStatus(e.message,true);return;}} exportWave(wave); });
  $$('#touchChannel button').forEach(btn=>btn.addEventListener('click',()=>switchTouchChannel(btn.dataset.touchCh)));
  $('#touchPulsePower').addEventListener('change',e=>{state.touch.power=Math.round(clamp(e.target.value,0,100));e.target.value=state.touch.power;$('#touchPowerView').textContent=state.touch.power;});
  $('#touchMaxPercent').addEventListener('change',e=>{state.touch.maxPercent=Math.round(clamp(e.target.value,1,100));e.target.value=state.touch.maxPercent;});
  const touchPad=$('#touchPad');
  touchPad.addEventListener('pointerdown',e=>{
    if((e.pointerType==='mouse'&&e.button!==0)||!canAdjustDesired())return;
    // Ignore a second pointer while one session is genuinely active. If only a
    // stale pointerId remains, clear it before accepting the new touch.
    if (state.touch.active) return;
    if (state.touch.pointerId !== null) endTouchOutput({ forceStop:false });
    e.preventDefault();
    state.touch.pointerId=e.pointerId;
    state.touch.active=true;
    state.touch.pending=null;
    state.touch.lastSentAt=0;
    try{touchPad.setPointerCapture(e.pointerId);}catch{}
    const v=touchValuesFromEvent(e);
    state.touch.freq=v.freq; state.touch.intensity=v.intensity;
    for(const ch of touchChannels()) state.desired[ch]=v.intensity;
    renderTouchPoint(v); scheduleTouchPayload(v); render();
  });
  touchPad.addEventListener('pointermove',e=>{
    if(!state.touch.active||e.pointerId!==state.touch.pointerId)return;
    e.preventDefault();
    const v=touchValuesFromEvent(e);
    state.touch.freq=v.freq; state.touch.intensity=v.intensity;
    for(const ch of touchChannels()) state.desired[ch]=v.intensity;
    renderTouchPoint(v); scheduleTouchPayload(v); render();
  });
  touchPad.addEventListener('pointerup',e=>{
    if(!state.touch.active||e.pointerId!==state.touch.pointerId)return;
    e.preventDefault();
    endTouchOutput();
  });
  touchPad.addEventListener('pointercancel',e=>{
    if(e.pointerId!==state.touch.pointerId)return;
    endTouchOutput();
  });
  touchPad.addEventListener('lostpointercapture',e=>{
    // Crucial: a delayed lostpointercapture from the PREVIOUS channel/pointer
    // must not cancel the newly-created session. Some browsers reuse pointerId,
    // so also verify that the current session does not already own capture.
    if(e.pointerId!==state.touch.pointerId)return;
    try { if (state.touch.active && touchPad.hasPointerCapture(e.pointerId)) return; } catch {}
    endTouchOutput({ releaseCapture:false });
  });
  touchPad.addEventListener('contextmenu',e=>e.preventDefault());

  validateRoomInput(false);
  render();
})();
