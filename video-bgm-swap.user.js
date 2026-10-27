// ==UserScript==
// @name         视频BGM替换器
// @namespace    https://github.com/yyx01/video-bgm-swap
// @version      0.5.0
// @description  替换网页视频背景音乐：人声音量滑到0=只留BGM，调大=保留人声（AI分离需本地服务）。支持导入洛雪(LX Music)/Sollin聚合音源文件，内置五大平台搜索，播放失败自动更换音源/平台/音质，自动识别视频时长。
// @author       yyx01
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/yyx01/video-bgm-swap
// @supportURL   https://github.com/yyx01/video-bgm-swap/issues
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 配置 ====================
  const CONFIG = {
    WS_URL: 'ws://127.0.0.1:8765',      // 本地人声分离服务
    HTTP_PROXY: 'http://127.0.0.1:8766', // 本地HTTP代理（音乐API/音频下载，绕过CORS）
    CHUNK_SIZE: 8192,                    // 音频块大小（采样数）
  };

  // ==================== AudioWorklet 处理器 ====================
  const WORKLET_CODE = `
class BgmSwapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = 2;
    this.chunkSize = ${CONFIG.CHUNK_SIZE};
    this.inputBuf = [];
    this.vocalQueue = [];
    this.accompQueue = [];
    this.vocalGain = 1.0;
    this.accompGain = 0.0;
    this.outBuf = new Float32Array(0);
    this.outPos = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'vocals') this.vocalQueue.push(d.data);
      else if (d.type === 'accomp') this.accompQueue.push(d.data);
      else if (d.type === 'params') {
        this.vocalGain = d.vocalGain;
        this.accompGain = d.accompGain;
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;
    const inCh = input.length;
    const outCh = output.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < this.channels; c++) {
        this.inputBuf.push(input[Math.min(c, inCh - 1)][i]);
      }
      if (this.inputBuf.length >= this.chunkSize * this.channels) {
        const chunk = new Float32Array(this.inputBuf);
        this.inputBuf = [];
        this.port.postMessage({ type: 'input', data: chunk.buffer }, [chunk.buffer]);
      }
    }
    const need = len * this.channels;
    while (this.outBuf.length - this.outPos < need) {
      const vocals = this.vocalQueue.shift();
      const accomp = this.accompQueue.shift();
      if (vocals && accomp) {
        const mixed = new Float32Array(vocals.length);
        for (let i = 0; i < vocals.length; i++) {
          mixed[i] = vocals[i] * this.vocalGain + accomp[i] * this.accompGain;
        }
        this.outBuf = mixed;
        this.outPos = 0;
      } else if (vocals) {
        // 只有人声：按人声音量输出（人声是通用的，始终保留）
        const mixed = new Float32Array(vocals.length);
        for (let i = 0; i < vocals.length; i++) mixed[i] = vocals[i] * this.vocalGain;
        this.outBuf = mixed;
        this.outPos = 0;
      } else if (accomp) {
        // 只有伴奏：按伴奏增益输出
        const mixed = new Float32Array(accomp.length);
        for (let i = 0; i < accomp.length; i++) mixed[i] = accomp[i] * this.accompGain;
        this.outBuf = mixed;
        this.outPos = 0;
      } else {
        this.outBuf = new Float32Array(need);
        this.outPos = 0;
        break;
      }
    }
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < outCh; c++) {
        const idx = this.outPos + i * this.channels + Math.min(c, this.channels - 1);
        output[c][i] = idx < this.outBuf.length ? this.outBuf[idx] : 0;
      }
    }
    this.outPos += need;
    return true;
  }
}
registerProcessor('bgm-swap-processor', BgmSwapProcessor);
`;

  const WORKLET_URL = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));

  // ==================== 状态 ====================
  const state = {
    enabled: false,
    library: [],           // 本地音源库
    currentBgmId: null,
    onlineResults: [],     // 在线搜索结果
    currentOnlineId: null,
    bgVolume: 0.8,
    vocalVolume: 1.0,
    bgmStartTime: 0,
    bgmEndTime: 0,
    bgmStartOffset: 0,
    ws: null,
    wsReady: false,
  };

  // 已导入的音源插件列表 [{name, handler}]
  const sourceList = [];

  let ctx = null;
  let sourceNode = null;
  let workletNode = null;
  let workletReady = false;
  let scriptProcessorNode = null;
  let scriptVocalsQueue = [];
  let scriptAccompQueue = [];
  let originalGainNode = null;
  let bgmSourceNode = null;
  let bgmGainNode = null;
  let bgmStartCtxTime = 0;    // BGM 开始播放时的 AudioContext 时间
  let bgmStartOffsetUsed = 0; // BGM 实际从音频的哪个位置开始
  let bgmPausedOffset = null; // 视频暂停时 BGM 的播放位置（null=无暂停记忆）
  let bgmPausedBgmId = null;  // 暂停时对应 BGM 的 id（切歌后忽略旧暂停位置）
  let currentVideo = null;
  let currentDuration = 0;
  let lastGraphKey = null;
  const handledVideos = new WeakSet();
  let panel = null;
  let miniBtn = null;
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let reconnectDelay = 3000; // WebSocket 重连间隔（失败时退避，最长15秒）

  // ==================== 工具函数 ====================
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    if (s < 10) s = '0' + s;
    return m + ':' + s;
  }

  function getCurrentBgm() {
    if (state.currentOnlineId) {
      var r = state.onlineResults.find(function (x) { return x.id === state.currentOnlineId; });
      if (r && r.buffer) {
        return { id: r.id, name: r.name + (r.singer ? ' - ' + r.singer : ''), buffer: r.buffer, duration: r.buffer.duration };
      }
    }
    return state.library.find(function (item) { return item.id === state.currentBgmId; }) || null;
  }

  function findMainVideo(root) {
    var videos = [];
    (function collect(node) {
      if (!node || typeof node.querySelectorAll !== 'function') return;
      try {
        var list = node.querySelectorAll('video');
        for (var i = 0; i < list.length; i++) videos.push(list[i]);
        var all = node.querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
          if (all[j].shadowRoot) collect(all[j].shadowRoot);
        }
      } catch (e) { /* 忽略权限错误 */ }
    })(root);
    if (videos.length === 0) return null;
    var playing = videos.filter(function (v) { return !v.paused && !v.ended; });
    if (playing.length > 0) return playing[0];
    videos.sort(function (a, b) {
      return (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight);
    });
    return videos[0];
  }

  function isInWindow() {
    if (!currentVideo) return false;
    var t = currentVideo.currentTime || 0;
    var start = state.bgmStartTime || 0;
    var end = state.bgmEndTime;
    return t >= start && (!end || t <= end);
  }

  function getAccompGain() {
    // 启用替换且在窗口内：原伴奏静音（由新BGM替代）
    // 未启用替换 / 窗口外：背景声音量控制原伴奏音量（人声音量始终由 vocalVolume 控制）
    return (state.enabled && isInWindow()) ? 0 : state.bgVolume;
  }

  // ==================== 纯JS加密工具（供 lx 音源调用） ====================
  // —— MD5（公共领域实现）——
  function md5(str) {
    function safeAdd(x, y) { var lsw = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xFFFF); }
    function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
    function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
    function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
    function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
    function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }
    function bytesToHex(bytes) {
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += (bytes[i].toString(16)).padStart(2, '0');
      return hex;
    }
    return bytesToHex(md5Loop(str, md5ff, md5gg, md5hh, md5ii, safeAdd));
  }
  // 独立的主循环实现
  function md5Loop(str, ff, gg, hh, ii, safeAdd) {
    function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
    function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
    var x = [], bytes = [], i, k, A, B, C, D;
    var len = str.length;
    for (i = 0; i < len; i++) bytes.push(str.charCodeAt(i));
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var bitLenLo = (len * 8) >>> 0;
    var bitLenHi = Math.floor(len * 8 / 0x100000000);
    // MD5 规范：64位比特长度以小端存放，低32位在前、高32位在后
    for (i = 0; i < 4; i++) bytes.push((bitLenLo >>> (i * 8)) & 0xFF);
    for (i = 0; i < 4; i++) bytes.push((bitLenHi >>> (i * 8)) & 0xFF);
    var out = new Array(16);
    var di = 0;
    for (i = 0; i < bytes.length; i += 64) {
      for (k = 0; k < 16; k++) {
        x[k] = bytes[i + k * 4] | (bytes[i + k * 4 + 1] << 8) | (bytes[i + k * 4 + 2] << 16) | (bytes[i + k * 4 + 3] << 24);
      }
      A = 0x67452301; B = 0xEFCDAB89; C = 0x98BADCFE; D = 0x10325476;
      A = ff(A, B, C, D, x[0], 7, 0xD76AA478); D = ff(D, A, B, C, x[1], 12, 0xE8C7B756); C = ff(C, D, A, B, x[2], 17, 0x242070DB); B = ff(B, C, D, A, x[3], 22, 0xC1BDCEEE);
      A = ff(A, B, C, D, x[4], 7, 0xF57C0FAF); D = ff(D, A, B, C, x[5], 12, 0x4787C62A); C = ff(C, D, A, B, x[6], 17, 0xA8304613); B = ff(B, C, D, A, x[7], 22, 0xFD469501);
      A = ff(A, B, C, D, x[8], 7, 0x698098D8); D = ff(D, A, B, C, x[9], 12, 0x8B44F7AF); C = ff(C, D, A, B, x[10], 17, 0xFFFF5BB1); B = ff(B, C, D, A, x[11], 22, 0x895CD7BE);
      A = ff(A, B, C, D, x[12], 7, 0x6B901122); D = ff(D, A, B, C, x[13], 12, 0xFD987193); C = ff(C, D, A, B, x[14], 17, 0xA679438E); B = ff(B, C, D, A, x[15], 22, 0x49B40821);
      A = gg(A, B, C, D, x[1], 5, 0xF61E2562); D = gg(D, A, B, C, x[6], 9, 0xC040B340); C = gg(C, D, A, B, x[11], 14, 0x265E5A51); B = gg(B, C, D, A, x[0], 20, 0xE9B6C7AA);
      A = gg(A, B, C, D, x[5], 5, 0xD62F105D); D = gg(D, A, B, C, x[10], 9, 0x02441453); C = gg(C, D, A, B, x[15], 14, 0xD8A1E681); B = gg(B, C, D, A, x[4], 20, 0xE7D3FBC8);
      A = gg(A, B, C, D, x[9], 5, 0x21E1CDE6); D = gg(D, A, B, C, x[14], 9, 0xC33707D6); C = gg(C, D, A, B, x[3], 14, 0xF4D50D87); B = gg(B, C, D, A, x[8], 20, 0x455A14ED);
      A = gg(A, B, C, D, x[13], 5, 0xA9E3E905); D = gg(D, A, B, C, x[2], 9, 0xFCEFA3F8); C = gg(C, D, A, B, x[7], 14, 0x676F02D9); B = gg(B, C, D, A, x[12], 20, 0x8D2A4C8A);
      A = hh(A, B, C, D, x[5], 4, 0xFFFA3942); D = hh(D, A, B, C, x[8], 11, 0x8771F681); C = hh(C, D, A, B, x[11], 16, 0x6D9D6122); B = hh(B, C, D, A, x[14], 23, 0xFDE5380C);
      A = hh(A, B, C, D, x[1], 4, 0xA4BEEA44); D = hh(D, A, B, C, x[4], 11, 0x4BDECFA9); C = hh(C, D, A, B, x[7], 16, 0xF6BB4B60); B = hh(B, C, D, A, x[10], 23, 0xBEBFBC70);
      A = hh(A, B, C, D, x[13], 4, 0x289B7EC6); D = hh(D, A, B, C, x[0], 11, 0xEAA127FA); C = hh(C, D, A, B, x[3], 16, 0xD4EF3085); B = hh(B, C, D, A, x[6], 23, 0x04881D05);
      A = hh(A, B, C, D, x[9], 4, 0xD9D4D039); D = hh(D, A, B, C, x[12], 11, 0xE6DB99E5); C = hh(C, D, A, B, x[15], 16, 0x1FA27CF8); B = hh(B, C, D, A, x[2], 23, 0xC4AC5665);
      A = ii(A, B, C, D, x[0], 6, 0xF4292244); D = ii(D, A, B, C, x[7], 10, 0x432AFF97); C = ii(C, D, A, B, x[14], 15, 0xAB9423A7); B = ii(B, C, D, A, x[5], 21, 0xFC93A039);
      A = ii(A, B, C, D, x[12], 6, 0x655B59C3); D = ii(D, A, B, C, x[3], 10, 0x8F0CCC92); C = ii(C, D, A, B, x[10], 15, 0xFFEFF47D); B = ii(B, C, D, A, x[1], 21, 0x85845DD1);
      A = ii(A, B, C, D, x[8], 6, 0x6FA87E4F); D = ii(D, A, B, C, x[15], 10, 0xFE2CE6E0); C = ii(C, D, A, B, x[6], 15, 0xA3014314); B = ii(B, C, D, A, x[13], 21, 0x4E0811A1);
      A = ii(A, B, C, D, x[4], 6, 0xF7537E82); D = ii(D, A, B, C, x[11], 10, 0xBD3AF235); C = ii(C, D, A, B, x[2], 15, 0x2AD7D2BB); B = ii(B, C, D, A, x[9], 21, 0xEB86D391);
      A = safeAdd(A, 0x67452301); B = safeAdd(B, 0xEFCDAB89); C = safeAdd(C, 0x98BADCFE); D = safeAdd(D, 0x10325476);
      out[di * 16 + 0] = A & 0xFF; out[di * 16 + 1] = (A >>> 8) & 0xFF; out[di * 16 + 2] = (A >>> 16) & 0xFF; out[di * 16 + 3] = (A >>> 24) & 0xFF;
      out[di * 16 + 4] = B & 0xFF; out[di * 16 + 5] = (B >>> 8) & 0xFF; out[di * 16 + 6] = (B >>> 16) & 0xFF; out[di * 16 + 7] = (B >>> 24) & 0xFF;
      out[di * 16 + 8] = C & 0xFF; out[di * 16 + 9] = (C >>> 8) & 0xFF; out[di * 16 + 10] = (C >>> 16) & 0xFF; out[di * 16 + 11] = (C >>> 24) & 0xFF;
      out[di * 16 + 12] = D & 0xFF; out[di * 16 + 13] = (D >>> 8) & 0xFF; out[di * 16 + 14] = (D >>> 16) & 0xFF; out[di * 16 + 15] = (D >>> 24) & 0xFF;
      di++;
    }
    return out;
  }

  // —— AES-128（ECB/CBC，PKCS7 填充；S-box 算法生成）——
  function buildAesSbox() {
    var sbox = new Array(256);
    var invSbox = new Array(256);
    // GF(2^8) 乘法（AES 不可约多项式 0x11B）
    function gmul(a, b) {
      var p = 0;
      for (var i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        var hi = a & 0x80;
        a = (a << 1) & 0xFF;
        if (hi) a ^= 0x1B;
        b >>= 1;
      }
      return p;
    }
    // 乘法逆元（穷举求解）
    function ginv(a) {
      for (var x = 1; x < 256; x++) {
        if (gmul(a, x) === 1) return x;
      }
      return 0;
    }
    function rotl(v, n) { return ((v << n) | (v >>> (8 - n))) & 0xFF; }
    // 对每个字节：求逆元 → 仿射变换 → 异或 0x63
    for (var i = 1; i < 256; i++) {
      var inv = ginv(i);
      var xformed = inv ^ rotl(inv, 1) ^ rotl(inv, 2) ^ rotl(inv, 3) ^ rotl(inv, 4);
      sbox[i] = (xformed ^ 0x63) & 0xFF;
    }
    sbox[0] = 0x63;
    for (var j = 0; j < 256; j++) invSbox[sbox[j]] = j;
    return { sbox: sbox, invSbox: invSbox };
  }
  var AES_TABLES = buildAesSbox();
  var AES_SBOX = AES_TABLES.sbox;
  var AES_RSBOX = AES_TABLES.invSbox;
  var AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36];

  function aesExpandKey(key) {
    var Nk = key.length / 4, Nr = Nk + 6;
    var w = [];
    var i, j;
    for (i = 0; i < Nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
    for (i = Nk; i < 4 * (Nr + 1); i++) {
      var temp = w[i - 1].slice();
      if (i % Nk === 0) {
        temp = [AES_SBOX[temp[1]], AES_SBOX[temp[2]], AES_SBOX[temp[3]], AES_SBOX[temp[0]]];
        temp[0] ^= AES_RCON[i / Nk - 1];
      } else if (Nk > 6 && i % Nk === 4) {
        temp = [AES_SBOX[temp[0]], AES_SBOX[temp[1]], AES_SBOX[temp[2]], AES_SBOX[temp[3]]];
      }
      w.push([
        w[i - Nk][0] ^ temp[0], w[i - Nk][1] ^ temp[1],
        w[i - Nk][2] ^ temp[2], w[i - Nk][3] ^ temp[3]
      ]);
    }
    return { w: w, Nr: Nr };
  }

  function aesAddRoundKey(state, w, round) {
    for (var i = 0; i < 16; i++) state[i] ^= w[round * 4 + Math.floor(i / 4)][i % 4];
  }
  function aesSubBytes(state, sbox) {
    for (var i = 0; i < 16; i++) state[i] = sbox[state[i]];
  }
  function aesShiftRows(state) {
    var t;
    t = state[1]; state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
    t = state[2]; state[2] = state[10]; state[10] = t; t = state[6]; state[6] = state[14]; state[14] = t;
    t = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = state[3]; state[3] = t;
  }
  function aesInvShiftRows(state) {
    var t;
    t = state[13]; state[13] = state[9]; state[9] = state[5]; state[5] = state[1]; state[1] = t;
    t = state[2]; state[2] = state[10]; state[10] = t; t = state[6]; state[6] = state[14]; state[14] = t;
    t = state[3]; state[3] = state[7]; state[7] = state[11]; state[11] = state[15]; state[15] = t;
  }
  function aesGmul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      var hi = a & 0x80;
      a = (a << 1) & 0xFF;
      if (hi) a ^= 0x1B;
      b >>= 1;
    }
    return p;
  }
  function aesMixColumns(state) {
    for (var i = 0; i < 4; i++) {
      var c = i * 4;
      var a0 = state[c], a1 = state[c + 1], a2 = state[c + 2], a3 = state[c + 3];
      state[c] = aesGmul(a0, 2) ^ aesGmul(a1, 3) ^ a2 ^ a3;
      state[c + 1] = a0 ^ aesGmul(a1, 2) ^ aesGmul(a2, 3) ^ a3;
      state[c + 2] = a0 ^ a1 ^ aesGmul(a2, 2) ^ aesGmul(a3, 3);
      state[c + 3] = aesGmul(a0, 3) ^ a1 ^ a2 ^ aesGmul(a3, 2);
    }
  }
  function aesInvMixColumns(state) {
    for (var i = 0; i < 4; i++) {
      var c = i * 4;
      var a0 = state[c], a1 = state[c + 1], a2 = state[c + 2], a3 = state[c + 3];
      state[c] = aesGmul(a0, 14) ^ aesGmul(a1, 11) ^ aesGmul(a2, 13) ^ aesGmul(a3, 9);
      state[c + 1] = aesGmul(a0, 9) ^ aesGmul(a1, 14) ^ aesGmul(a2, 11) ^ aesGmul(a3, 13);
      state[c + 2] = aesGmul(a0, 13) ^ aesGmul(a1, 9) ^ aesGmul(a2, 14) ^ aesGmul(a3, 11);
      state[c + 3] = aesGmul(a0, 11) ^ aesGmul(a1, 13) ^ aesGmul(a2, 9) ^ aesGmul(a3, 14);
    }
  }

  function aesEncryptBlock(block, w, Nr) {
    aesAddRoundKey(block, w, 0);
    for (var round = 1; round < Nr; round++) {
      aesSubBytes(block, AES_SBOX);
      aesShiftRows(block);
      aesMixColumns(block);
      aesAddRoundKey(block, w, round);
    }
    aesSubBytes(block, AES_SBOX);
    aesShiftRows(block);
    aesAddRoundKey(block, w, Nr);
    return block;
  }
  function aesDecryptBlock(block, w, Nr) {
    aesAddRoundKey(block, w, Nr);
    for (var round = Nr - 1; round > 0; round--) {
      aesInvShiftRows(block);
      aesInvSubBytes(block);
      aesAddRoundKey(block, w, round);
      aesInvMixColumns(block);
    }
    aesInvShiftRows(block);
    aesInvSubBytes(block);
    aesAddRoundKey(block, w, 0);
    return block;
  }
  function aesInvSubBytes(state) {
    for (var i = 0; i < 16; i++) state[i] = AES_RSBOX[state[i]];
  }
  function aesInvShiftRowsWrap(state) { aesInvShiftRows(state); }

  function strToUtf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else if (c < 0x10000) { bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
      else { bytes.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
    }
    return bytes;
  }
  function utf8BytesToStr(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b < 0x80) { out += String.fromCharCode(b); }
      else if ((b >> 5) === 0x6) {
        out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 1;
      } else if ((b >> 4) === 0xE) {
        out += String.fromCharCode(((b & 0xF) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 2;
      } else if ((b >> 3) === 0x1E) {
        var cp = ((b & 0x7) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        i += 3;
      } else {
        i += 3;
      }
    }
    return out;
  }
  function pkcs7Pad(data, blockSize) {
    var pad = blockSize - (data.length % blockSize);
    var out = data.slice();
    for (var i = 0; i < pad; i++) out.push(pad);
    return out;
  }
  function pkcs7Unpad(data) {
    var pad = data[data.length - 1];
    if (!pad || pad > 16) return data;
    return data.slice(0, data.length - pad);
  }

  function aesCrypt(dataBytes, keyBytes, ivBytes, encrypt) {
    var key = keyBytes.length === 16 ? keyBytes : pkcs7Pad(keyBytes, 16).slice(0, 16);
    var exp = aesExpandKey(key);
    var blockSize = 16;
    var useCbc = ivBytes && ivBytes.length > 0;
    var padded = encrypt ? pkcs7Pad(dataBytes, blockSize) : dataBytes.slice();
    if (padded.length % blockSize !== 0 && !encrypt) padded = pkcs7Pad(padded, blockSize);
    var result = [];
    var prev = useCbc ? ivBytes.slice(0, 16) : new Array(16).fill(0);
    for (var i = 0; i < padded.length; i += 16) {
      var block = padded.slice(i, i + 16);
      if (encrypt) {
        if (useCbc) {
          for (var j = 0; j < 16; j++) block[j] ^= prev[j];
        }
        block = aesEncryptBlock(block, exp.w, exp.Nr);
        if (useCbc) prev = block;
      } else {
        var orig = block.slice();
        block = aesDecryptBlock(block, exp.w, exp.Nr);
        if (useCbc) {
          for (j = 0; j < 16; j++) block[j] ^= prev[j];
          prev = orig;
        }
      }
      for (j = 0; j < 16; j++) result.push(block[j]);
    }
    return encrypt ? result : pkcs7Unpad(result);
  }

  function aesEncrypt(data, mode, key, iv) {
    var keyBytes = strToUtf8Bytes(String(key || ''));
    var ivBytes = iv ? strToUtf8Bytes(String(iv)) : null;
    var dataBytes = typeof data === 'string' ? strToUtf8Bytes(data) : Array.prototype.slice.call(new Uint8Array(data));
    return new Uint8Array(aesCrypt(dataBytes, keyBytes, ivBytes, true));
  }
  function aesDecrypt(data, mode, key, iv) {
    var keyBytes = strToUtf8Bytes(String(key || ''));
    var ivBytes = iv ? strToUtf8Bytes(String(iv)) : null;
    var dataBytes = typeof data === 'string' ? strToUtf8Bytes(data) : Array.prototype.slice.call(new Uint8Array(data));
    return new Uint8Array(aesCrypt(dataBytes, keyBytes, ivBytes, false));
  }

  // ==================== lx 宿主桥接（Sollin/LX 音源导入模式） ====================
  function createLxShim(captureHandler, rawScript) {
    return {
      EVENT_NAMES: { request: 'request', inited: 'inited' },
      request: function (url, options, callback) {
        options = options || {};
        fetch(CONFIG.HTTP_PROXY + '/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: String(url),
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body || null
          })
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) callback(new Error(data.error));
            else callback(null, { statusCode: data.statusCode || 0, headers: data.headers || {}, body: data.body });
          })
          .catch(function (err) { callback(err); });
      },
      on: function (event, handler) {
        if (event === 'request') {
          if (captureHandler) captureHandler(handler);
        }
      },
      send: function () { /* 忽略初始化消息 */ },
      utils: {
        crypto: {
          md5: md5,
          aesEncrypt: aesEncrypt,
          aesDecrypt: aesDecrypt,
          randomBytes: function (n) {
            var a = new Uint8Array(n);
            if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
            else for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
            return a;
          }
        },
        buffer: {
          bufToString: function (buf, encoding) {
            var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            if (encoding === 'hex') {
              var hex = '';
              for (var i = 0; i < u8.length; i++) hex += u8[i].toString(16).padStart(2, '0');
              return hex;
            }
            if (encoding === 'base64') {
              var bin = '';
              for (var j = 0; j < u8.length; j++) bin += String.fromCharCode(u8[j]);
              return btoa(bin);
            }
            var s = '';
            for (var k = 0; k < u8.length; k++) s += String.fromCharCode(u8[k]);
            return s;
          },
          stringToBuf: function (str, encoding) {
            if (encoding === 'hex') {
              var out = new Uint8Array(Math.floor(str.length / 2));
              for (var i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
              return out;
            }
            if (encoding === 'base64') {
              var bin = atob(str);
              var arr = new Uint8Array(bin.length);
              for (var j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
              return arr;
            }
            return new TextEncoder().encode(String(str));
          }
        }
      },
      version: '2.8.0',
      env: { platform: 'web', version: '2.8.0' },
      currentScriptInfo: rawScript ? { rawScript: rawScript } : null,
    };
  }

  function extractSourceName(text) {
    var m1 = text.match(/@name\s+(.+)/);
    if (m1) return m1[1].trim();
    var m2 = text.match(/\/\*!\s*\*\s*@name\s+(.+)/);
    if (m2) return m2[1].trim();
    return '自定义音源';
  }

  function initMusicSource(text) {
    try {
      var handler = null;
      globalThis.lx = createLxShim(function (h) { handler = h; }, text);
      var fn = new Function(text); // 隔离作用域执行音源插件
      fn();
      if (handler) {
        sourceList.push({ name: extractSourceName(text), handler: handler, text: text });
        persistSources();
        renderSourceList();
        return true;
      }
      return false;
    } catch (e) {
      console.error('音源解析失败:', e);
      return false;
    }
  }

  // ==================== 音源持久化（只导入一次，刷新后自动恢复） ====================
  var SOURCE_STORAGE_KEY = 'bgmSwap_sources_v1';

  function persistSources() {
    try {
      localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(sourceList.map(function (s) { return { name: s.name, text: s.text }; })));
    } catch (e) {
      console.warn('音源持久化失败（localStorage 可能已满）:', e);
    }
  }

  function loadPersistedSources() {
    var raw = null;
    try { raw = localStorage.getItem(SOURCE_STORAGE_KEY); } catch (e) { return; }
    if (!raw) return;
    var arr = null;
    try { arr = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(arr)) return;
    arr.forEach(function (item) {
      if (item && item.text) initMusicSource(item.text);
    });
  }

  function removeSource(index) {
    if (index < 0 || index >= sourceList.length) return;
    sourceList.splice(index, 1);
    persistSources();
    renderSourceList();
    renderLibrary();
  }

  function clearSources() {
    sourceList.length = 0;
    try { localStorage.removeItem(SOURCE_STORAGE_KEY); } catch (e) { /* ignore */ }
    renderSourceList();
    renderLibrary();
  }

  function renderSourceList() {
    if (!panel) return;
    var el = panel.querySelector('#bgm-source-list');
    if (!el) return;
    if (sourceList.length === 0) {
      el.innerHTML = '<span style="color:#777">未导入音源（导入后自动保存，下次不用再导）</span>';
      return;
    }
    var html = '';
    sourceList.forEach(function (s, i) {
      html += '<span style="display:inline-flex;align-items:center;background:#2a2a3a;border-radius:8px;padding:1px 4px;margin:1px 2px 1px 0;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtml(s.name) + '">' +
        escapeHtml(s.name) +
        '<button data-src-remove="' + i + '" title="删除该音源" style="background:none;border:none;color:#e88;font-size:12px;cursor:pointer;line-height:1;padding:0 1px;margin-left:2px">×</button></span>';
    });
    el.innerHTML = html;
  }

  // 依次尝试所有已导入音源，返回播放URL
  async function callMusicUrl(musicInfo, platform, type) {
    var lastErr = null;
    for (var i = sourceList.length - 1; i >= 0; i--) {
      try {
        var url = await sourceList[i].handler({
          action: 'musicUrl',
          source: platform,
          info: { musicInfo: musicInfo, type: type }
        });
        if (url) return url;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('所有音源均未返回URL');
  }

  // 用音源自身搜索（如全豆要的汽水搜索）
  async function searchFromSources(keyword) {
    var results = [];
    for (var i = sourceList.length - 1; i >= 0; i--) {
      try {
        var res = await sourceList[i].handler({
          action: 'musicSearch', source: 'qsvip', info: { keyword: keyword, page: 1, pagesize: 10 }
        });
        var list = (res && res.list) || [];
        for (var j = 0; j < list.length; j++) {
          results.push(normalizeOnlineItem(list[j], 'qsvip', '汽水', j));
        }
      } catch (e) { /* 该音源不支持搜索则忽略 */ }
    }
    return results;
  }

  // ==================== 五大平台搜索（经本地代理） ====================
  async function proxyGetJson(url, referer) {
    var headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' };
    if (referer) headers['Referer'] = referer;
    var resp = await fetch(CONFIG.HTTP_PROXY + '/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, method: 'GET', headers: headers, body: null })
    });
    var data = await resp.json();
    if (data.error) throw new Error(data.error);
    if (data.statusCode >= 400) throw new Error('HTTP ' + data.statusCode);
    try { return JSON.parse(data.body); } catch (e) { throw new Error('响应不是JSON'); }
  }

  async function searchWy(keyword) {
    var url = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(keyword) + '&type=1&limit=30&offset=0';
    var data = await proxyGetJson(url, 'https://music.163.com/');
    return ((data.result && data.result.songs) || []).map(function (s) {
      return {
        id: s.id,
        songmid: s.id,
        name: s.name,
        singer: (s.artists || []).map(function (a) { return a.name; }).join('/'),
        albumName: (s.album && s.album.name) || '',
        pic: (s.album && s.album.picUrl) || '',
        duration: Math.round((s.duration || 0) / 1000),
        meta: { wy: { id: s.id } }
      };
    });
  }

  async function searchTx(keyword) {
    var url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&w=' + encodeURIComponent(keyword) +
      '&p=1&n=20&cr=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0';
    var data = await proxyGetJson(url, 'https://y.qq.com/');
    var list = (data.data && data.data.song && data.data.song.list) || [];
    return list.map(function (s) {
      var mid = s.songmid || s.mid || '';
      return {
        id: mid || s.songid,
        songmid: mid,
        mid: mid,
        name: s.songname || s.name || '',
        singer: (s.singer || []).map(function (x) { return x.name; }).join('/'),
        albumName: s.albumname || '',
        pic: s.albummid ? 'https://y.qq.com/music/photo_new/T002R300x300M000' + s.albummid + '.jpg' : '',
        duration: s.interval || 0,
        meta: { qq: { mid: mid, songid: s.songid } }
      };
    });
  }

  async function searchKw(keyword) {
    var url = 'https://search.kuwo.cn/r.s?all=' + encodeURIComponent(keyword) +
      '&ft=music&itemset=web_2013&client=kt&pn=0&rn=20&rformat=json&encoding=utf8&vipver=1';
    var data = await proxyGetJson(url, 'https://www.kuwo.cn/');
    var list = data.abslist || [];
    return list.map(function (s) {
      var rid = s.MUSICRID || s.rid || '';
      return {
        id: rid,
        rid: rid,
        name: s.SONGTITLE || s.name || '',
        singer: s.SINGER || s.artist || '',
        albumName: s.ALBUM || '',
        pic: '',
        duration: Math.round((parseInt(s.DURATION, 10) || 0) / 1000),
        meta: { kw: { rid: rid } }
      };
    });
  }

  async function searchKg(keyword) {
    var url = 'https://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' + encodeURIComponent(keyword) + '&page=1&pagesize=20&showtype=1';
    var data = await proxyGetJson(url, 'https://www.kugou.com/');
    var list = (data.data && data.data.info) || [];
    return list.map(function (s) {
      var hash = s.hash || s.fileHash || '';
      return {
        id: hash,
        hash: hash,
        name: s.songname || s.filename || '',
        singer: s.singername || '',
        albumName: s.album_name || '',
        pic: s.album_id ? 'https://img.kugou.com/std_album_240/' + s.album_id + '/index.jpg' : '',
        duration: s.duration || 0,
        meta: { kg: { hash: hash } }
      };
    });
  }

  async function searchMg(keyword) {
    var url = 'https://music.migu.cn/v3/api/music/audio/search?keyword=' + encodeURIComponent(keyword) +
      '&pgc=1&rows=20&searchSwitch=' + encodeURIComponent('{"song":1}');
    var data = await proxyGetJson(url, 'https://music.migu.cn/');
    var list = data.songs || [];
    return list.map(function (s) {
      var singerName = Array.isArray(s.singer)
        ? s.singer.map(function (x) { return x.name || ''; }).join('/')
        : (s.singer && s.singer.name) || '';
      var dur = 0;
      if (typeof s.duration === 'number') dur = Math.round(s.duration / 1000);
      else if (typeof s.duration === 'string') {
        var parts = s.duration.split(':');
        if (parts.length === 2) dur = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
      }
      return {
        id: s.songId,
        songId: s.songId,
        name: s.songName || '',
        singer: singerName,
        albumName: s.albumName || '',
        pic: '',
        duration: dur,
        meta: { mg: { songId: s.songId } }
      };
    });
  }

  function normalizeOnlineItem(item, platform, platformName, index) {
    return {
      id: 'online_' + Date.now() + '_' + platform + '_' + index + '_' + Math.random().toString(36).slice(2, 6),
      name: item.name || item.title || item.songname || '未知歌曲',
      singer: item.singer || item.artist || item.singername || '',
      albumName: item.albumName || '',
      duration: item.duration || 0,
      platform: platform,
      platformName: platformName,
      raw: item,
      buffer: null,
      status: 'ready'
    };
  }

  async function searchOnline(keyword) {
    setStatusText('正在搜索在线音乐...');
    var tasks = [
      searchWy(keyword).then(function (list) { return list.map(function (x, i) { return normalizeOnlineItem(x, 'wy', '网易云', i); }); }),
      searchTx(keyword).then(function (list) { return list.map(function (x, i) { return normalizeOnlineItem(x, 'tx', 'QQ音乐', i); }); }),
      searchKw(keyword).then(function (list) { return list.map(function (x, i) { return normalizeOnlineItem(x, 'kw', '酷我', i); }); }),
      searchKg(keyword).then(function (list) { return list.map(function (x, i) { return normalizeOnlineItem(x, 'kg', '酷狗', i); }); }),
      searchMg(keyword).then(function (list) { return list.map(function (x, i) { return normalizeOnlineItem(x, 'mg', '咪咕', i); }); }),
      searchFromSources(keyword)
    ];
    var settled = await Promise.allSettled(tasks);
    var results = [];
    var failCount = 0;
    settled.forEach(function (r) {
      if (r.status === 'fulfilled') results = results.concat(r.value);
      else { failCount++; console.warn('在线搜索任务失败:', r.reason); }
    });
    state.onlineResults = results;
    renderLibrary();
    updateStatusText();
    if (results.length === 0) {
      if (failCount > 0) setStatusText('搜索失败：请确认已运行 python bgm-separate-server.py（8766代理）');
      else setStatusText('没有搜索到结果');
    }
  }

  // ==================== 在线BGM：播放失败自动换源/换平台/换音质 ====================
  async function loadOnlineBgm(item) {
    if (sourceList.length === 0) { setStatusText('请先导入音源'); return; }
    item.status = 'loading';
    renderLibrary();

    var attempts = [
      { platform: item.platform, type: '320k' },
      { platform: item.platform, type: '128k' },
      { platform: 'qsvip', type: '320k', useSourceSearch: true },
      { platform: 'kw', type: '128k' },
      { platform: 'mg', type: '128k' },
      { platform: 'wy', type: '320k' },
      { platform: 'tx', type: '128k' }
    ];

    for (var i = 0; i < attempts.length; i++) {
      var a = attempts[i];
      try {
        var url = null;
        if (a.useSourceSearch) {
          url = await getUrlViaSourceSearch(item, a.type);
        } else {
          url = await callMusicUrl(item.raw, a.platform, a.type);
        }
        if (!url) throw new Error('空URL');
        var buffer = await fetchAudioBuffer(url);
        if (buffer) {
          item.buffer = buffer;
          item.status = 'ready';
          state.currentOnlineId = item.id;
          state.currentBgmId = null;
          renderLibrary();
          syncBgm();
          updateStatusText();
          setStatusText('已加载: ' + item.name + '（' + item.platformName + ' · 音源' + a.type + '）');
          return;
        }
      } catch (e) {
        console.warn('尝试', a.platform, a.type, '失败:', e.message || e);
      }
    }
    item.status = 'failed';
    renderLibrary();
    setStatusText('该歌曲所有音源/平台都获取失败');
  }

  async function getUrlViaSourceSearch(item, type) {
    var keyword = item.name + (item.singer ? ' ' + item.singer : '');
    var lastErr = null;
    for (var i = sourceList.length - 1; i >= 0; i--) {
      try {
        var res = await sourceList[i].handler({
          action: 'musicSearch', source: 'qsvip', info: { keyword: keyword, page: 1, pagesize: 1 }
        });
        var list = (res && res.list) || [];
        if (list.length > 0) {
          var url = await sourceList[i].handler({
            action: 'musicUrl', source: 'qsvip', info: { musicInfo: list[0], type: type }
          });
          if (url) return url;
        }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('音源搜索失败');
  }

  async function fetchAudioBuffer(url) {
    if (!ctx) throw new Error('AudioContext 未就绪');
    var resp = await fetch(CONFIG.HTTP_PROXY + '/audio?url=' + encodeURIComponent(url));
    if (!resp.ok) throw new Error('音频下载失败 HTTP ' + resp.status);
    var arr = await resp.arrayBuffer();
    return await ctx.decodeAudioData(arr);
  }

  // ==================== 音频图（不变核心） ====================
  async function ensureAudioSetup() {
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    if (sourceNode) return;
    var video = findMainVideo(document);
    if (!video) return;
    try {
      sourceNode = ctx.createMediaElementSource(video);
      currentVideo = video;
      handledVideos.add(video);
      lastGraphKey = null;
    } catch (e) { console.error('接管视频音频失败:', e); return; }
    if (!workletReady && ctx.audioWorklet) {
      try { await ctx.audioWorklet.addModule(WORKLET_URL); workletReady = true; }
      catch (e) { workletReady = false; }
    }
    applyGraph(); // 总是建立音频通路（直通/分离图/原声增益），避免任何状态下视频无声
  }

  async function setupAudio() {
    if (!ctx || !sourceNode) return;
    var video = findMainVideo(document);
    if (!video) return;
    if (handledVideos.has(video)) { currentVideo = video; return; }
    try { await ctx.close(); } catch (e) {}
    ctx = null; sourceNode = null; workletNode = null; workletReady = false;
    scriptProcessorNode = null; scriptVocalsQueue = []; scriptAccompQueue = [];
    originalGainNode = null; lastGraphKey = null;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 }); }
    catch (e) { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    try {
      sourceNode = ctx.createMediaElementSource(video);
      currentVideo = video;
      handledVideos.add(video);
      lastGraphKey = null;
    } catch (e) { console.error('接管新视频音频失败:', e); }
    if (ctx.audioWorklet) {
      try { await ctx.audioWorklet.addModule(WORKLET_URL); workletReady = true; }
      catch (e) { workletReady = false; }
    }
    applyGraph(); // 总是建立音频通路，避免任何状态下视频无声
  }

  function teardownGraph() {
    if (workletNode) { try { workletNode.disconnect(); } catch (e) {} try { workletNode.port.close(); } catch (e) {} workletNode = null; }
    if (scriptProcessorNode) { try { scriptProcessorNode.disconnect(); } catch (e) {} scriptProcessorNode = null; }
    scriptVocalsQueue.length = 0; scriptAccompQueue.length = 0;
    if (originalGainNode) { try { originalGainNode.disconnect(); } catch (e) {} originalGainNode = null; }
    if (bgmSourceNode) { try { bgmSourceNode.stop(); } catch (e) {} bgmSourceNode = null; }
    if (bgmGainNode) { try { bgmGainNode.disconnect(); } catch (e) {} bgmGainNode = null; }
  }

  function applyGraph() {
    if (!ctx || !sourceNode) return;
    // 图结构只随 AI 连接状态变化：
    //   - AI 模式：worklet 分离图（无论是否启用替换，人声/伴奏滑块可调）
    //   - 无AI模式：原声增益图（启用/停用只改增益，不重建，避免切换时杂音/静音）
    var key = state.wsReady ? 'ws' : 'plain';
    if (key === lastGraphKey) return;
    lastGraphKey = key;
    teardownGraph();
    sourceNode.disconnect();
    if (state.wsReady) {
      // AI 分离图：无论是否启用替换都走这里，人声/伴奏滑块始终可调
      if (workletReady) {
        try {
          workletNode = new AudioWorkletNode(ctx, 'bgm-swap-processor');
          workletNode.port.onmessage = onWorkletMessage;
          sourceNode.connect(workletNode);
          workletNode.connect(ctx.destination);
          updateWorkletParams();
        } catch (e) { workletReady = false; createScriptProcessorPath(); }
      } else if (ctx.createScriptProcessor) { createScriptProcessorPath(); }
      else { sourceNode.connect(ctx.destination); }
    } else {
      // 无AI模式：始终走原声增益图（切换替换只改增益值，音频通路保持连通）
      originalGainNode = ctx.createGain();
      originalGainNode.gain.value = 1;
      sourceNode.connect(originalGainNode);
      originalGainNode.connect(ctx.destination);
    }
    syncBgm();
    updateStatusText();
  }

  function onWorkletMessage(e) {
    var d = e.data;
    if (d.type === 'input' && state.ws && state.ws.readyState === WebSocket.OPEN) {
      try { state.ws.send(d.data); } catch (err) {}
    }
  }

  function createScriptProcessorPath() {
    scriptProcessorNode = ctx.createScriptProcessor(CONFIG.CHUNK_SIZE, 2, 2);
    scriptProcessorNode.onaudioprocess = onScriptAudioProcess;
    sourceNode.connect(scriptProcessorNode);
    scriptProcessorNode.connect(ctx.destination);
  }

  function interleaveChannels(buffer) {
    var channels = buffer.numberOfChannels;
    var len = buffer.length;
    var out = new Float32Array(len * channels);
    for (var c = 0; c < channels; c++) {
      var data = buffer.getChannelData(c);
      for (var i = 0; i < len; i++) out[i * channels + c] = data[i];
    }
    return out;
  }

  function onScriptAudioProcess(event) {
    var input = event.inputBuffer;
    var output = event.outputBuffer;
    var c, i;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try { state.ws.send(interleaveChannels(input).buffer); } catch (e) {}
    }
    var vocals = scriptVocalsQueue.shift();
    var accomp = scriptAccompQueue.shift();
    var accompGain = getAccompGain();
    if (vocals || accomp) {
      for (c = 0; c < output.numberOfChannels; c++) {
        var outData = output.getChannelData(c);
        for (i = 0; i < output.length; i++) {
          var v = vocals ? vocals[i * 2 + c] * state.vocalVolume : 0;
          var a = accomp ? accomp[i * 2 + c] * accompGain : 0;
          outData[i] = v + a;
        }
      }
    } else {
      for (c = 0; c < output.numberOfChannels; c++) output.getChannelData(c).fill(0);
    }
  }

  function updateWorkletParams() {
    if (!workletNode) return;
    workletNode.port.postMessage({ type: 'params', vocalGain: state.vocalVolume, accompGain: getAccompGain() });
  }

  // ==================== BGM 与替换窗口控制 ====================
  function syncBgm() {
    if (!ctx || !sourceNode) return;
    var inWindow = isInWindow();
    var bgm = getCurrentBgm();
    var videoPaused = !!(currentVideo && currentVideo.paused);
    var shouldPlay = state.enabled && inWindow && !!bgm && !videoPaused;
    if (originalGainNode) {
      // 无AI兜底：替换窗口内静音原声播BGM；其余情况原声保持 1.0（切换只改增益，干净无杂音）
      var target = (state.enabled && inWindow && bgm) ? 0 : 1;
      originalGainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
    }
    if (shouldPlay && !bgmSourceNode) {
      // 视频从暂停恢复：若还是同一首BGM，从暂停位置接着播；切歌则从头开始
      var resumeOffset = (bgmPausedBgmId === (bgm && bgm.id)) ? bgmPausedOffset : null;
      bgmPausedOffset = null;
      bgmPausedBgmId = null;
      startBgm(resumeOffset != null ? resumeOffset : undefined);
    } else if (shouldPlay && bgmSourceNode && bgmGainNode) {
      bgmGainNode.gain.setTargetAtTime(state.bgVolume, ctx.currentTime, 0.1);
    } else if (!shouldPlay && bgmSourceNode) {
      // 视频暂停时，记住BGM当前位置并停止，恢复播放时接着播
      if (videoPaused) {
        bgmPausedOffset = getBgmCurrentOffset();
        bgmPausedBgmId = bgm ? bgm.id : null;
      }
      stopBgm();
    }
    if (!originalGainNode) updateWorkletParams();
    updateDurationDisplay();
  }

  function startBgm(fromOffset) {
    var bgm = getCurrentBgm();
    if (!ctx || !bgm) return;
    stopBgm();
    var src = ctx.createBufferSource();
    src.buffer = bgm.buffer;
    src.loop = true;
    var gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(ctx.destination);
    var dur = bgm.duration || 1;
    var offset = fromOffset != null
      ? Math.min(Math.max(fromOffset, 0), dur - 0.01)
      : Math.min(Math.max(state.bgmStartOffset || 0, 0), dur - 0.01);
    src.start(0, offset);
    gain.gain.setTargetAtTime(state.bgVolume, ctx.currentTime, 0.1);
    bgmSourceNode = src;
    bgmGainNode = gain;
    bgmStartCtxTime = ctx.currentTime;
    bgmStartOffsetUsed = offset;
  }

  // 计算 BGM 当前播放位置（考虑循环取模）
  function getBgmCurrentOffset() {
    if (!bgmSourceNode || !ctx) return null;
    var bgm = getCurrentBgm();
    var dur = (bgm && bgm.duration) || 1;
    var elapsed = ctx.currentTime - bgmStartCtxTime;
    var pos = bgmStartOffsetUsed + elapsed;
    if (pos >= dur) pos = pos % dur;
    return pos;
  }

  function stopBgm() {
    if (!bgmSourceNode && !bgmGainNode) return;
    var src = bgmSourceNode;
    var gain = bgmGainNode;
    bgmSourceNode = null;
    bgmGainNode = null;
    if (gain && ctx) { try { gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05); } catch (e) {} }
    setTimeout(function () {
      try { src && src.stop(); } catch (e) {}
      try { gain && gain.disconnect(); } catch (e) {}
    }, 300);
  }

  // ==================== 本地分离服务连接 ====================
  function connectServer() {
    try { if (state.ws) state.ws.close(); } catch (e) {}
    state.wsReady = false;
    try {
      state.ws = new WebSocket(CONFIG.WS_URL);
      state.ws.binaryType = 'arraybuffer';
      state.ws.onopen = function () { reconnectDelay = 3000; state.wsReady = true; updateStatusText(); updateAiHint(); applyGraph(); };
      state.ws.onclose = function () {
        state.wsReady = false; updateStatusText(); updateAiHint(); applyGraph();
        setTimeout(connectServer, reconnectDelay);
        reconnectDelay = Math.min(Math.round(reconnectDelay * 1.5), 15000);
      };
      state.ws.onerror = function () { state.wsReady = false; updateStatusText(); updateAiHint(); };
      state.ws.onmessage = function (ev) {
        try {
          var data = new Float32Array(ev.data);
          var n = Math.floor(data.length / 4);
          if (n === 0) return;
          var vocals = new Float32Array(n * 2);
          var accomp = new Float32Array(n * 2);
          for (var i = 0; i < n; i++) {
            vocals[i * 2] = data[i * 4];
            vocals[i * 2 + 1] = data[i * 4 + 1];
            accomp[i * 2] = data[i * 4 + 2];
            accomp[i * 2 + 1] = data[i * 4 + 3];
          }
          if (workletNode) {
            workletNode.port.postMessage({ type: 'vocals', data: vocals }, [vocals.buffer]);
            workletNode.port.postMessage({ type: 'accomp', data: accomp }, [accomp.buffer]);
          } else if (scriptProcessorNode) {
            scriptVocalsQueue.push(vocals);
            scriptAccompQueue.push(accomp);
          }
        } catch (e) {}
      };
    } catch (e) { setTimeout(connectServer, 3000); }
  }

  // ==================== 本地音源库 ====================
  function addFilesToLibrary(fileList) {
    if (!ctx) return;
    Array.prototype.forEach.call(fileList, function (file) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        ctx.decodeAudioData(ev.target.result).then(function (buffer) {
          var item = {
            id: 'bgm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            name: file.name.replace(/\.[^.]+$/, ''),
            buffer: buffer,
            duration: buffer.duration,
          };
          state.library.push(item);
          if (!state.currentBgmId && !state.currentOnlineId) state.currentBgmId = item.id;
          renderLibrary();
          syncBgm();
        }).catch(function (err) { console.error('BGM 解码失败:', file.name, err); });
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // ==================== 面板 UI ====================
  function createPanel() {
    panel = document.createElement('div');
    panel.id = 'bgm-swap-panel';
    panel.style.cssText = 'position:fixed;top:80px;right:12px;z-index:999999;width:300px;background:rgba(18,18,18,0.96);color:#eee;font-family:system-ui,sans-serif;font-size:13px;border-radius:10px;padding:0;box-shadow:0 4px 20px rgba(0,0,0,0.5);user-select:none';

    panel.innerHTML =
      '<div id="bgm-panel-header" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;cursor:move;border-bottom:1px solid #333">' +
      '  <b>🎵 BGM 替换器</b>' +
      '  <span style="white-space:nowrap">' +
      '    <button id="bgm-panel-min" title="最小化" style="background:none;border:none;color:#aaa;font-size:14px;cursor:pointer;line-height:1;margin-right:4px">—</button>' +
      '    <button id="bgm-panel-close" title="收起" style="background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;line-height:1">×</button>' +
      '  </span>' +
      '</div>' +
      '<div id="bgm-panel-body" style="padding:10px">' +
      '  <label style="display:block;margin-bottom:6px"><input type="checkbox" id="bgm-enable" style="vertical-align:middle"> <span>启用替换</span></label>' +
      '  <div style="margin-bottom:4px">人声音量 <input type="range" id="vocal-vol" min="0" max="100" value="100" style="width:62%;vertical-align:middle"></div>' +
      '  <div style="margin-bottom:2px">背景声音量 <input type="range" id="bg-vol" min="0" max="100" value="80" style="width:62%;vertical-align:middle"></div>' +
      '  <div style="margin-bottom:6px;font-size:11px;color:#888">背景声：替换中=新BGM，未替换时=原伴奏；人声拉到底=只留BGM</div>' +
      '  <div id="bgm-ai-hint" style="margin-bottom:6px;font-size:11px;color:#e8a13c;display:none"></div>' +
      '  <div style="margin-bottom:4px;font-size:12px">BGM开始时间(秒) <input type="number" id="bgm-start-time" value="0" min="0" step="1" style="width:60px;padding:2px;background:#222;color:#eee;border:1px solid #444;border-radius:4px"></div>' +
      '  <div style="margin-bottom:4px;font-size:12px">BGM结束时间(秒,留空=到底) <input type="number" id="bgm-end-time" min="0" step="1" style="width:60px;padding:2px;background:#222;color:#eee;border:1px solid #444;border-radius:4px"></div>' +
      '  <div style="margin-bottom:6px;font-size:12px">BGM起始位置(秒) <input type="number" id="bgm-start-offset" value="0" min="0" step="1" style="width:60px;padding:2px;background:#222;color:#eee;border:1px solid #444;border-radius:4px"></div>' +
      '  <div id="bgm-duration" style="font-size:11px;color:#888;margin-bottom:6px">视频时长: 加载中...</div>' +
      '  <div style="display:flex;gap:4px;margin-bottom:6px">' +
      '    <button id="bgm-add" style="flex:1;padding:5px;border:none;border-radius:6px;background:#3a6ea5;color:#fff;cursor:pointer">➕ 本地音乐</button>' +
      '    <button id="bgm-import-source" style="flex:1;padding:5px;border:none;border-radius:6px;background:#6a4fa5;color:#fff;cursor:pointer">📦 导入音源</button>' +
      '  </div>' +
      '  <input type="file" id="bgm-file-input" accept="audio/*" multiple style="display:none">' +
      '  <input type="file" id="bgm-source-input" accept=".js,application/javascript,text/javascript" multiple style="display:none">' +
      '  <div id="bgm-source-list" style="font-size:11px;margin-bottom:6px;line-height:1.7"></div>' +
      '  <div style="display:flex;gap:4px;margin-bottom:6px">' +
      '    <input type="text" id="bgm-search" placeholder="输入歌名/歌手在线搜索" style="flex:1;box-sizing:border-box;padding:4px;border:1px solid #444;border-radius:6px;background:#222;color:#eee">' +
      '    <button id="bgm-search-btn" style="padding:4px 8px;border:none;border-radius:6px;background:#3a6ea5;color:#fff;cursor:pointer">搜索</button>' +
      '  </div>' +
      '  <div id="bgm-list" style="max-height:160px;overflow-y:auto;margin-bottom:6px;font-size:12px"></div>' +
      '  <div id="bgm-status" style="font-size:11px;color:#999;margin-top:2px"></div>' +
      '</div>';

    document.documentElement.appendChild(panel);

    miniBtn = document.createElement('div');
    miniBtn.id = 'bgm-swap-mini';
    miniBtn.textContent = '🎵';
    miniBtn.style.cssText = 'position:fixed;top:80px;right:12px;z-index:999999;cursor:pointer;font-size:18px;background:rgba(18,18,18,0.9);color:#eee;border-radius:50%;width:34px;height:34px;display:none;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.4)';
    document.documentElement.appendChild(miniBtn);

    var header = panel.querySelector('#bgm-panel-header');
    header.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      dragOffsetX = e.clientX - panel.offsetLeft;
      dragOffsetY = e.clientY - panel.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panel.style.left = (e.clientX - dragOffsetX) + 'px';
      panel.style.top = (e.clientY - dragOffsetY) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { dragging = false; });

    var minBtn = panel.querySelector('#bgm-panel-min');
    minBtn.addEventListener('click', function () {
      var body = panel.querySelector('#bgm-panel-body');
      var collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      minBtn.textContent = collapsed ? '—' : '▢';
      panel.style.width = collapsed ? '300px' : 'auto';
    });

    panel.querySelector('#bgm-panel-close').addEventListener('click', function () {
      panel.style.display = 'none';
      miniBtn.style.display = 'flex';
    });
    miniBtn.addEventListener('click', function () {
      panel.style.display = 'block';
      miniBtn.style.display = 'none';
    });

    panel.querySelector('#bgm-enable').addEventListener('change', function (ev) {
      setEnabled(ev.target.checked);
    });

    panel.querySelector('#bgm-add').addEventListener('click', function () {
      panel.querySelector('#bgm-file-input').click();
    });
    panel.querySelector('#bgm-file-input').addEventListener('change', function (ev) {
      addFilesToLibrary(ev.target.files);
      ev.target.value = '';
    });

    panel.querySelector('#bgm-import-source').addEventListener('click', function () {
      panel.querySelector('#bgm-source-input').click();
    });
    panel.querySelector('#bgm-source-input').addEventListener('change', function (ev) {
      var files = Array.prototype.slice.call(ev.target.files || []);
      ev.target.value = '';
      if (files.length === 0) return;
      var pending = files.length, okCount = 0, failCount = 0;
      files.forEach(function (file) {
        var reader = new FileReader();
        reader.onload = function (e2) {
          var ok = initMusicSource(e2.target.result);
          if (ok) okCount++; else failCount++;
          pending--;
          if (pending === 0) {
            if (okCount > 0) {
              setStatusText('音源导入成功: ' + sourceList.map(function (s) { return s.name; }).join(' / '));
            } else {
              setStatusText('音源导入失败（文件格式不兼容）');
            }
          }
        };
        reader.readAsText(file, 'utf-8');
      });
    });

    panel.querySelector('#bgm-source-list').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-src-remove]');
      if (!btn) return;
      removeSource(parseInt(btn.getAttribute('data-src-remove'), 10));
    });

    var searchInput = panel.querySelector('#bgm-search');
    panel.querySelector('#bgm-search-btn').addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doSearch(); });
    searchInput.addEventListener('input', function () {
      if (sourceList.length === 0) renderLibrary(); // 未导入音源时搜索框用于过滤本地
    });

    panel.querySelector('#bgm-list').addEventListener('click', function (ev) {
      var el = ev.target.closest('[data-id]');
      if (!el) return;
      var type = el.getAttribute('data-type');
      var id = el.getAttribute('data-id');
      if (type === 'online') {
        var item = state.onlineResults.find(function (x) { return x.id === id; });
        if (!item) return;
        if (item.buffer) {
          state.currentOnlineId = id;
          state.currentBgmId = null;
          renderLibrary();
          syncBgm();
        } else if (item.status !== 'loading') {
          loadOnlineBgm(item);
        }
      } else {
        state.currentBgmId = id;
        state.currentOnlineId = null;
        renderLibrary();
        syncBgm();
      }
    });

    panel.querySelector('#vocal-vol').addEventListener('input', function (ev) {
      state.vocalVolume = ev.target.value / 100;
      syncBgm();
    });
    panel.querySelector('#bg-vol').addEventListener('input', function (ev) {
      state.bgVolume = ev.target.value / 100;
      syncBgm();
    });

    panel.querySelector('#bgm-start-time').addEventListener('change', function (ev) {
      state.bgmStartTime = parseFloat(ev.target.value) || 0;
      syncBgm();
    });
    panel.querySelector('#bgm-end-time').addEventListener('change', function (ev) {
      state.bgmEndTime = parseFloat(ev.target.value) || 0;
      syncBgm();
    });
    panel.querySelector('#bgm-start-offset').addEventListener('change', function (ev) {
      state.bgmStartOffset = parseFloat(ev.target.value) || 0;
      if (bgmSourceNode) { stopBgm(); syncBgm(); }
    });

    document.addEventListener('click', function () {
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
    }, true);

    loadPersistedSources();
    renderSourceList();
    renderLibrary();
    updateStatusText();
    updateAiHint();
    updateDurationDisplay();
  }

  function doSearch() {
    var kw = (panel.querySelector('#bgm-search').value || '').trim();
    if (!kw) return;
    if (sourceList.length > 0) searchOnline(kw);
    else renderLibrary(); // 本地过滤
  }

  function renderLibrary() {
    if (!panel) return;
    var listEl = panel.querySelector('#bgm-list');
    var html = '';

    if (state.onlineResults.length > 0) {
      html += '<div style="color:#888;padding:2px 4px">🌐 在线结果</div>';
      for (var i = 0; i < state.onlineResults.length; i++) {
        var item = state.onlineResults[i];
        var active = item.id === state.currentOnlineId;
        var status = item.status === 'loading' ? ' ⏳' : (item.status === 'failed' ? ' ❌' : '');
        var label = (active ? '▶ ' : '') + '[' + item.platformName + '] ' + escapeHtml(item.name) + (item.singer ? ' - ' + escapeHtml(item.singer) : '');
        if (item.duration > 0) label += ' <span style="color:#777">' + fmtTime(item.duration) + '</span>';
        html += '<div data-type="online" data-id="' + item.id + '" style="padding:3px 5px;cursor:pointer;border-radius:4px;background:' + (active ? '#3a6ea5' : 'transparent') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + escapeHtml(item.name + ' - ' + item.singer + ' · ' + item.platformName) + '">' +
          label + status + '</div>';
      }
    }

    var keyword = (panel.querySelector('#bgm-search').value || '').trim().toLowerCase();
    var localItems = state.library.filter(function (it) {
      return !keyword || it.name.toLowerCase().indexOf(keyword) !== -1;
    });

    if (state.library.length > 0) {
      html += '<div style="color:#888;padding:2px 4px">📁 本地</div>';
      for (var j = 0; j < localItems.length; j++) {
        var local = localItems[j];
        var localActive = local.id === state.currentBgmId;
        var mins = Math.floor(local.duration / 60);
        var secs = Math.floor(local.duration % 60);
        if (secs < 10) secs = '0' + secs;
        html += '<div data-type="local" data-id="' + local.id + '" style="padding:3px 5px;cursor:pointer;border-radius:4px;background:' + (localActive ? '#3a6ea5' : 'transparent') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + escapeHtml(local.name) + '">' +
          (localActive ? '▶ ' : '') + escapeHtml(local.name) + ' <span style="color:#777">' + mins + ':' + secs + '</span></div>';
      }
    }

    if (html === '') html = '<div style="color:#777;padding:4px">导入音源后，输入歌名/歌手搜索在线音乐；或添加本地文件</div>';
    listEl.innerHTML = html;
  }

  function updateDurationDisplay() {
    if (!panel) return;
    var el = panel.querySelector('#bgm-duration');
    if (!el) return;
    if (currentVideo && isFinite(currentVideo.duration) && currentVideo.duration > 0) currentDuration = currentVideo.duration;
    if (currentDuration > 0) {
      el.textContent = '视频时长: ' + fmtTime(currentDuration) + '（结束时间留空=播到结尾）';
      var endInput = panel.querySelector('#bgm-end-time');
      if (endInput && !endInput.getAttribute('max')) endInput.setAttribute('max', Math.floor(currentDuration));
    } else {
      el.textContent = '视频时长: 加载中...';
    }
  }

  function setStatusText(text) {
    if (!panel) return;
    var el = panel.querySelector('#bgm-status');
    if (el) el.textContent = text;
  }

  function updateAiHint() {
    if (!panel) return;
    var el = panel.querySelector('#bgm-ai-hint');
    var vocalSlider = panel.querySelector('#vocal-vol');
    if (!el) return;
    if (state.wsReady) {
      el.style.display = 'none';
      if (vocalSlider) vocalSlider.disabled = false;
    } else {
      el.style.display = 'block';
      el.textContent = '⚠️ AI人声分离未连接：人声音量不可用（无法单独保留人声）。如需人声分离，请运行 python bgm-separate-server.py --ai';
      if (vocalSlider) vocalSlider.disabled = true;
    }
  }

  function updateStatusText() {
    if (!panel) return;
    if (!state.enabled) { setStatusText('状态：未启用（原声播放中）'); return; }
    if (state.wsReady && !workletReady && !scriptProcessorNode) {
      setStatusText('状态：当前浏览器不支持实时处理');
      return;
    }
    var bgm = getCurrentBgm();
    var win = '全部';
    if (state.bgmStartTime > 0 || state.bgmEndTime > 0) {
      win = fmtTime(state.bgmStartTime) + '~' + (state.bgmEndTime ? fmtTime(state.bgmEndTime) : '结尾');
    }
    var engine = state.wsReady ? 'AI人声分离' : '仅BGM兜底';
    var sourceInfo = 'BGM:' + (bgm ? bgm.name : '无');
    if (sourceList.length > 0) sourceInfo += ' · 已导入' + sourceList.length + '个音源';
    setStatusText('状态：已启用 · ' + engine + ' · ' + win + ' · ' + sourceInfo);
  }

  function setEnabled(enabled) {
    state.enabled = enabled;
    if (enabled) {
      ensureAudioSetup().then(function () { applyGraph(); syncBgm(); updateStatusText(); });
    } else {
      applyGraph();
      syncBgm();
      updateStatusText();
    }
  }

  // ==================== 初始化 ====================
  function init() {
    var video = findMainVideo(document);
    if (!video) return;
    createPanel();
    try { ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 }); }
    catch (e) { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    connectServer();
    setInterval(function () {
      if (!ctx || !sourceNode) return;
      if (!currentVideo || !currentVideo.isConnected) {
        currentVideo = null;
        setupAudio();
      }
    }, 1000);
    setInterval(syncBgm, 200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 页面离开时主动关闭 WebSocket，让本地服务安静退出（不发关闭帧会在服务端刷 "no close frame" 日志）
  window.addEventListener('pagehide', function () {
    try { if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close(1000, 'pagehide'); } catch (e) { /* ignore */ }
  });
})();