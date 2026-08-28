/**
 * camera.js — <camera-scanner> Web Component
 * Phiên bản: 1.0.0
 * Tương thích: Chrome Android, Safari iOS, Samsung Internet, file://, https://
 *
 * Cách dùng:
 *   <script src="camera.js"></script>
 *   <camera-scanner frame="square" ui="true" output="base64"></camera-scanner>
 *
 * Tài liệu đầy đủ: xem CAMERA_CONTEXT.md
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // HẰNG SỐ
  // ─────────────────────────────────────────────────────────────
  const FRAMES = {
    square : { label: 'Vuông',              w: 80, h: 80,   r: 12,  ar: null  },
    card   : { label: 'Thẻ ngang',          w: 88, h: 56,   r: 10,  ar: 1.586 },
    a4     : { label: 'Tài liệu A4',        w: 70, h: 90,   r: 8,   ar: 0.707 },
    oval   : { label: 'Oval khuôn mặt',     w: 72, h: 88,   r: 50,  ar: null  },
    circle : { label: 'Tròn dấu mộc',       w: 75, h: 75,   r: 50,  ar: 1     },
    none   : { label: 'Không khung',        w: 0,  h: 0,    r: 0,   ar: null  },
  };

  const HINTS = {
    square : 'Hướng camera vào đối tượng',
    card   : 'Đặt thẻ vào khung, giữ thẳng',
    a4     : 'Giữ tài liệu phẳng trong khung',
    oval   : 'Nhìn thẳng vào camera',
    circle : 'Đặt dấu mộc vào vòng tròn',
    none   : '',
  };

  const ERROR_MESSAGES = {
    NotAllowedError         : { code: 'PERMISSION_DENIED', msg: 'Bạn chưa cấp quyền camera. Vào Cài đặt trình duyệt để cấp lại.', recoverable: false },
    PermissionDeniedError   : { code: 'PERMISSION_DENIED', msg: 'Bạn chưa cấp quyền camera. Vào Cài đặt trình duyệt để cấp lại.', recoverable: false },
    NotFoundError           : { code: 'NOT_FOUND',         msg: 'Không tìm thấy camera trên thiết bị này.',                       recoverable: false },
    DevicesNotFoundError    : { code: 'NOT_FOUND',         msg: 'Không tìm thấy camera trên thiết bị này.',                       recoverable: false },
    NotReadableError        : { code: 'IN_USE',            msg: 'Camera đang được dùng bởi ứng dụng khác. Đóng app đó rồi thử lại.', recoverable: true },
    AbortError              : { code: 'IN_USE',            msg: 'Camera đang được dùng bởi ứng dụng khác.',                       recoverable: true },
    NotSupportedError       : { code: 'NOT_SUPPORTED',     msg: 'Trình duyệt không hỗ trợ camera. Vui lòng dùng Chrome hoặc Safari.', recoverable: false },
    SecurityError           : { code: 'HTTPS_REQUIRED',    msg: 'Camera cần HTTPS hoặc file://. Liên hệ người cung cấp link.',    recoverable: false },
    OverconstrainedError    : { code: 'CONSTRAINT_ERROR',  msg: 'Camera không đáp ứng yêu cầu, đang thử lại...',                 recoverable: true },
    ConstraintNotSatisfiedError: { code: 'CONSTRAINT_ERROR', msg: 'Camera không đáp ứng yêu cầu, đang thử lại...',               recoverable: true },
  };

  // ─────────────────────────────────────────────────────────────
  // DETECT IN-APP BROWSER
  // ─────────────────────────────────────────────────────────────
  function isInAppBrowser() {
    const ua = navigator.userAgent || '';
    return /FBAN|FBAV|Instagram|ZaloApp|Line\/|KAKAOTALK|MicroMessenger/i.test(ua);
  }

  // ─────────────────────────────────────────────────────────────
  // SHARPNESS — Laplacian Variance (không cần thư viện ngoài)
  // ─────────────────────────────────────────────────────────────
  function measureSharpness(canvas, x, y, w, h) {
    // Lấy vùng sample (tối đa 200×200 để tính nhanh)
    const sw = Math.min(w, 200);
    const sh = Math.min(h, 200);
    const sx = x + (w - sw) / 2;
    const sy = y + (h - sh) / 2;

    const tmp = document.createElement('canvas');
    tmp.width = sw; tmp.height = sh;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

    const data = ctx.getImageData(0, 0, sw, sh).data;
    const len  = sw * sh;

    // Chuyển sang grayscale
    const gray = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
    }

    // Laplacian kernel: [0,1,0,1,-4,1,0,1,0]
    let sum = 0, count = 0;
    for (let row = 1; row < sh - 1; row++) {
      for (let col = 1; col < sw - 1; col++) {
        const idx = row * sw + col;
        const lap = -4 * gray[idx]
          + gray[idx - 1] + gray[idx + 1]
          + gray[idx - sw] + gray[idx + sw];
        sum += lap * lap;
        count++;
      }
    }

    const variance = count > 0 ? sum / count : 0;
    // Normalize: variance ~0–8000 → 0–100
    return Math.min(100, Math.round(Math.sqrt(variance) * 1.8));
  }

  // ─────────────────────────────────────────────────────────────
  // IMAGE PROCESSING
  // ─────────────────────────────────────────────────────────────
  function processCanvas(srcCanvas, opts) {
    // opts: { cropX, cropY, cropW, cropH, maxWidth, quality, grayscale, output }
    let { cropX, cropY, cropW, cropH, maxWidth, quality, grayscale, output } = opts;

    // Scale down nếu cần
    const scale = cropW > maxWidth ? maxWidth / cropW : 1;
    const outW  = Math.round(cropW * scale);
    const outH  = Math.round(cropH * scale);

    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const ctx = out.getContext('2d');
    ctx.drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

    if (grayscale) {
      const img = ctx.getImageData(0, 0, outW, outH);
      const d   = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
        d[i] = d[i+1] = d[i+2] = g;
      }
      ctx.putImageData(img, 0, 0);
    }

    const dataUrl = out.toDataURL('image/jpeg', quality);
    const blob    = (output === 'blob' || output === 'both')
      ? dataURLtoBlob(dataUrl) : null;

    return { dataUrl: (output !== 'blob') ? dataUrl : null, blob, width: outW, height: outH };
  }

  function dataURLtoBlob(dataUrl) {
    const [header, data] = dataUrl.split(',');
    const mime  = header.match(/:(.*?);/)[1];
    const bytes = atob(data);
    const arr   = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  // ─────────────────────────────────────────────────────────────
  // SHADOW DOM STYLES
  // ─────────────────────────────────────────────────────────────
  const STYLE = `
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
      font-family: 'Segoe UI', system-ui, sans-serif;
      -webkit-tap-highlight-color: transparent;
    }

    video {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }

    canvas { display: none; }

    /* ── Overlay ── */
    #overlay {
      position: absolute; inset: 0;
      pointer-events: none;
    }

    /* ── Khung quét ── */
    #frame-box {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      border: 2px solid var(--frame-color, #f0a500);
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.48);
      transition: width .3s, height .3s, border-radius .3s;
    }

    #frame-box.frame-none {
      border: none;
      box-shadow: none;
    }

    /* Lưới mờ bên trong khung */
    #frame-box.show-grid::before,
    #frame-box.show-grid::after {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    #frame-box.show-grid::before {
      background-image:
        linear-gradient(rgba(255,255,255,.12) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.12) 1px, transparent 1px);
      background-size: 33.33% 33.33%;
    }

    /* ── 4 góc trang trí ── */
    .corner {
      position: absolute;
      width: 22px; height: 22px;
      border-color: var(--frame-color, #f0a500);
      border-style: solid;
      opacity: .9;
    }
    .corner.tl { top:-2px; left:-2px;   border-width:3px 0 0 3px; border-radius:8px 0 0 0; }
    .corner.tr { top:-2px; right:-2px;  border-width:3px 3px 0 0; border-radius:0 8px 0 0; }
    .corner.bl { bottom:-2px; left:-2px;  border-width:0 0 3px 3px; border-radius:0 0 0 8px; }
    .corner.br { bottom:-2px; right:-2px; border-width:0 3px 3px 0; border-radius:0 0 8px 0; }

    /* Ẩn góc khi frame=oval/circle */
    :host([frame="oval"]) .corner,
    :host([frame="circle"]) .corner { display: none; }

    /* ── Đường quét ── */
    #scan-line {
      position: absolute; left: 4%; right: 4%; height: 2px;
      background: linear-gradient(90deg, transparent, var(--frame-color, #f0a500), transparent);
      top: 5%; opacity: 0;
    }
    #scan-line.active { animation: scanMove 2.2s ease-in-out infinite; }
    @keyframes scanMove {
      0%  { top: 5%;  opacity: 0 }
      8%  { opacity: 1 }
      92% { opacity: 1 }
      100%{ top: 93%; opacity: 0 }
    }

    /* ── Hint text ── */
    #hint {
      position: absolute;
      bottom: 10px; left: 0; right: 0;
      text-align: center;
      font-size: 12px; color: rgba(255,255,255,.82);
      text-shadow: 0 1px 5px #000;
      padding: 0 16px;
    }

    /* ── Thanh sharpness ── */
    #sharpness-wrap {
      position: absolute;
      top: 12px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,.6);
      border-radius: 20px;
      padding: 5px 12px;
      display: none;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      backdrop-filter: blur(4px);
    }
    #sharpness-wrap.visible { display: flex; }
    #sharpness-label { font-size: 11px; color: rgba(255,255,255,.75); }
    #sharpness-track {
      width: 80px; height: 6px;
      background: rgba(255,255,255,.2);
      border-radius: 3px; overflow: hidden;
    }
    #sharpness-fill {
      height: 100%;
      background: #2ecc71;
      border-radius: 3px;
      width: 0%;
      transition: width .2s, background .2s;
    }
    #sharpness-fill.low    { background: #e74c3c; }
    #sharpness-fill.medium { background: #f39c12; }
    #sharpness-fill.high   { background: #2ecc71; }
    #sharpness-pct { font-size: 11px; color: #fff; font-weight: 600; width: 28px; }

    /* ── Zoom indicator ── */
    #zoom-indicator {
      position: absolute;
      top: 12px; right: 14px;
      background: rgba(0,0,0,.6);
      color: #fff; font-size: 12px; font-weight: 700;
      padding: 4px 10px; border-radius: 12px;
      display: none;
      backdrop-filter: blur(4px);
    }
    #zoom-indicator.visible { display: block; }

    /* ── In-app browser warning ── */
    #inapp-warn {
      position: absolute; inset: 0;
      background: #111;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px 24px;
      text-align: center;
      color: #fff;
    }
    #inapp-warn.visible { display: flex; }
    #inapp-warn .ico { font-size: 52px; margin-bottom: 16px; }
    #inapp-warn h2   { font-size: 18px; margin-bottom: 10px; }
    #inapp-warn p    { font-size: 13px; color: #aaa; line-height: 1.6; }

    /* ── Error overlay ── */
    #error-overlay {
      position: absolute; inset: 0;
      background: rgba(0,0,0,.85);
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      color: #fff;
    }
    #error-overlay.visible { display: flex; }
    #error-overlay .err-ico { font-size: 40px; margin-bottom: 12px; }
    #error-overlay .err-msg { font-size: 13px; color: #ddd; line-height: 1.6; margin-bottom: 16px; }
    #error-overlay button {
      padding: 10px 24px; border: none; border-radius: 10px;
      background: #e74c3c; color: #fff;
      font-size: 14px; font-weight: 600; cursor: pointer;
    }

    /* ── UI Controls ── */
    #controls {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      padding: 0 20px calc(env(safe-area-inset-bottom, 0px) + 20px);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 20px;
      pointer-events: all;
    }
    #controls.hidden { display: none; }

    .ctrl-btn {
      background: rgba(30,30,30,.85);
      border: 1px solid rgba(255,255,255,.15);
      border-radius: 50%;
      color: #fff;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: transform .1s, opacity .1s;
      backdrop-filter: blur(6px);
      flex-shrink: 0;
    }
    .ctrl-btn:active { transform: scale(.9); opacity: .75; }
    .ctrl-btn.hidden { display: none !important; }

    #btn-flip    { width: 48px; height: 48px; font-size: 18px; }
    #btn-capture {
      width: 70px; height: 70px; font-size: 26px;
      background: rgba(220,50,50,.9);
      border: 3px solid rgba(255,255,255,.5);
      border-radius: 50%;
    }
    #btn-zoom-out { width: 40px; height: 40px; font-size: 16px; }
    #btn-zoom-in  { width: 40px; height: 40px; font-size: 16px; }
    #btn-torch    { width: 48px; height: 48px; font-size: 18px; }
    #btn-torch.on { background: rgba(255,200,0,.85); color: #333; }

    /* ── Auto-capture countdown ring ── */
    #capture-ring {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 80px; height: 80px;
      pointer-events: none;
      display: none;
    }
    #capture-ring.visible { display: block; }
    #capture-ring circle {
      fill: none;
      stroke: #2ecc71;
      stroke-width: 4;
      stroke-linecap: round;
      stroke-dasharray: 220;
      stroke-dashoffset: 220;
      transition: stroke-dashoffset .8s linear;
      transform-origin: center;
      transform: rotate(-90deg);
    }
  `;

  // ─────────────────────────────────────────────────────────────
  // HTML TEMPLATE
  // ─────────────────────────────────────────────────────────────
  const TEMPLATE = `
    <style>${STYLE}</style>

    <video autoplay playsinline muted></video>
    <canvas></canvas>

    <div id="overlay">
      <div id="frame-box">
        <div class="corner tl"></div>
        <div class="corner tr"></div>
        <div class="corner bl"></div>
        <div class="corner br"></div>
        <div id="scan-line"></div>
        <svg id="capture-ring" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="35"/>
        </svg>
      </div>
      <div id="sharpness-wrap">
        <span id="sharpness-label">Độ nét</span>
        <div id="sharpness-track"><div id="sharpness-fill"></div></div>
        <span id="sharpness-pct">0%</span>
      </div>
      <div id="zoom-indicator">1.0×</div>
      <div id="hint"></div>
    </div>

    <div id="controls">
      <button class="ctrl-btn" id="btn-torch"    title="Đèn flash">🔦</button>
      <button class="ctrl-btn" id="btn-zoom-out" title="Thu nhỏ">－</button>
      <button class="ctrl-btn" id="btn-capture"  title="Chụp">⬤</button>
      <button class="ctrl-btn" id="btn-zoom-in"  title="Phóng to">＋</button>
      <button class="ctrl-btn" id="btn-flip"     title="Đổi camera">🔄</button>
    </div>

    <div id="inapp-warn">
      <div class="ico">⚠️</div>
      <h2>Mở bằng Chrome hoặc Safari</h2>
      <p>Trình duyệt trong ứng dụng không hỗ trợ camera.<br>
         Nhấn ⋯ (hoặc ···) → <strong>Mở bằng trình duyệt</strong></p>
    </div>

    <div id="error-overlay">
      <div class="err-ico">📷</div>
      <div class="err-msg"></div>
      <button id="btn-retry">Thử lại</button>
    </div>
  `;

  // ─────────────────────────────────────────────────────────────
  // WEB COMPONENT
  // ─────────────────────────────────────────────────────────────
  class CameraScanner extends HTMLElement {

    // Attributes được theo dõi để tự cập nhật khi thay đổi
    static get observedAttributes() {
      return [
        'frame', 'frame-color', 'frame-size', 'show-grid', 'show-guide',
        'ui', 'hide-controls', 'auto-capture', 'sharpness-threshold',
        'sharpness-bar', 'output', 'max-width', 'quality', 'grayscale',
        'crop-to-frame', 'facing', 'hint', 'continuous', 'continuous-interval',
      ];
    }

    constructor() {
      super();
      this._root    = this.attachShadow({ mode: 'open' });
      this._root.innerHTML = TEMPLATE;

      // ── Internal state ──
      this._stream      = null;
      this._zoom        = 1.0;
      this._torchOn     = false;
      this._busy        = false;
      this._autoTimer   = null;
      this._sharpTimer  = null;
      this._autoConfirm = 0;   // bộ đếm frame liên tiếp đủ nét
      this._track       = null; // MediaStreamTrack (để zoom/torch)

      // ── Public callbacks ──
      this.onResult    = null;
      this.onReady     = null;
      this.onError     = null;
      this.onSharpness = null;

      // ── Bind methods ──
      this._onVisibility = this._onVisibility.bind(this);
      this._onFreeze     = this._onFreeze.bind(this);
      this._onResume     = this._onResume.bind(this);
    }

    // ── Helpers: lấy element trong shadow ──
    _q(sel) { return this._root.querySelector(sel); }

    // ── Helpers: đọc attribute với giá trị mặc định ──
    _attr(name, def) {
      const v = this.getAttribute(name);
      return v === null ? def : v;
    }
    _bool(name, def = false) {
      const v = this.getAttribute(name);
      if (v === null) return def;
      return v !== 'false';
    }
    _num(name, def) {
      const v = parseFloat(this.getAttribute(name));
      return isNaN(v) ? def : v;
    }

    // ─────────────────────────────────────────────────────────
    // LIFECYCLE CALLBACKS
    // ─────────────────────────────────────────────────────────
    connectedCallback() {
      this._setupEvents();
      this._applyFrame();
      this._applyUI();

      // Tự khởi động camera khi gắn vào DOM
      if (!isInAppBrowser()) {
        this.start();
      } else {
        this._q('#inapp-warn').classList.add('visible');
      }
    }

    disconnectedCallback() {
      // Dọn dẹp khi component bị xoá khỏi DOM
      this.stop();
      document.removeEventListener('visibilitychange', this._onVisibility);
      document.removeEventListener('freeze',           this._onFreeze);
      document.removeEventListener('resume',           this._onResume);
    }

    attributeChangedCallback(name) {
      // Tự cập nhật khi attribute thay đổi lúc runtime
      if (!this._root) return;
      if (['frame','frame-color','frame-size','show-grid','show-guide'].includes(name)) {
        this._applyFrame();
      }
      if (['ui','hide-controls'].includes(name)) {
        this._applyUI();
      }
      if (name === 'hint') {
        this._q('#hint').textContent = this._attr('hint', HINTS[this._attr('frame','square')] || '');
      }
      if (name === 'facing') {
        if (this._stream) this.start(); // Restart với facing mới
      }
      if (name === 'sharpness-bar') {
        this._q('#sharpness-wrap').classList.toggle('visible', this._bool('sharpness-bar'));
      }
      if (name === 'continuous' || name === 'continuous-interval') {
        if (this._bool('continuous')) this.startContinuous();
        else this.stopContinuous();
      }
    }

    // ─────────────────────────────────────────────────────────
    // SETUP EVENTS
    // ─────────────────────────────────────────────────────────
    _setupEvents() {
      // Nút điều khiển
      this._q('#btn-capture').addEventListener('click',  () => this.capture());
      this._q('#btn-flip')   .addEventListener('click',  () => this.flip());
      this._q('#btn-zoom-in').addEventListener('click',  () => this.zoomIn());
      this._q('#btn-zoom-out').addEventListener('click', () => this.zoomOut());
      this._q('#btn-torch')  .addEventListener('click',  () => this.torch(!this._torchOn));
      this._q('#btn-retry')  .addEventListener('click',  () => {
        this._q('#error-overlay').classList.remove('visible');
        this.start();
      });

      // Pinch-to-zoom
      this._setupPinch();

      // Visibility / lifecycle
      document.addEventListener('visibilitychange', this._onVisibility);
      document.addEventListener('freeze',           this._onFreeze);
      document.addEventListener('resume',           this._onResume);
    }

    _setupPinch() {
      let dist0 = 0, zoom0 = 1;
      const vid = this._q('video');
      vid.addEventListener('touchstart', e => {
        if (e.touches.length === 2) {
          dist0 = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          zoom0 = this._zoom;
        }
      }, { passive: true });
      vid.addEventListener('touchmove', e => {
        if (e.touches.length === 2) {
          const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          this.setZoom(zoom0 * dist / dist0);
        }
      }, { passive: true });
    }

    _onVisibility() {
      if (document.visibilityState === 'hidden') {
        this.stopContinuous();
        this._stopSharpnessLoop();
      } else {
        // Kiểm tra stream còn sống không
        const ended = !this._stream ||
          this._stream.getTracks().some(t => t.readyState === 'ended');
        if (ended) {
          this.start();
        } else {
          if (this._bool('continuous'))   this.startContinuous();
          if (this._bool('auto-capture')) this._startSharpnessLoop();
          if (this._bool('sharpness-bar'))this._startSharpnessLoop();
        }
      }
    }
    _onFreeze() { this.stopContinuous(); this._stopSharpnessLoop(); }
    _onResume() {
      if (this._bool('continuous'))    this.startContinuous();
      if (this._bool('auto-capture'))  this._startSharpnessLoop();
      if (this._bool('sharpness-bar')) this._startSharpnessLoop();
    }

    // ─────────────────────────────────────────────────────────
    // APPLY FRAME OVERLAY
    // ─────────────────────────────────────────────────────────
    _applyFrame() {
      const frameType = this._attr('frame', 'square');
      const cfg       = FRAMES[frameType] || FRAMES.square;
      const color     = this._attr('frame-color', '#f0a500');
      const size      = this._num('frame-size', 85);
      const showGrid  = this._bool('show-grid');
      const showGuide = this._bool('show-guide', true);
      const hintTxt   = this._attr('hint', HINTS[frameType] || '');

      const box = this._q('#frame-box');
      const sl  = this._q('#scan-line');

      // CSS custom property cho màu
      this._root.host.style.setProperty('--frame-color', color);

      if (frameType === 'none') {
        box.className = 'frame-none';
        box.style.cssText = '';
        sl.classList.remove('active');
        this._q('#hint').textContent = '';
        return;
      }

      // Tính kích thước khung
      const baseW = size;
      let boxW, boxH;

      if (cfg.ar) {
        // Tỉ lệ cố định (card=1.586, circle=1)
        boxW = baseW;
        // Tính % height dựa trên AR — giả định host là square-ish
        // Dùng vw để tính đơn giản
        boxH = null; // sẽ set bằng aspect-ratio
      } else {
        boxW = cfg.w;
        boxH = cfg.h;
      }

      box.className = '';
      if (showGrid) box.classList.add('show-grid');

      box.style.width        = boxW + '%';
      box.style.height       = boxH ? boxH + '%' : '';
      box.style.aspectRatio  = cfg.ar ? `${cfg.ar}` : '';
      box.style.borderRadius = cfg.r + (cfg.r === 50 ? '%' : 'px');

      if (showGuide && frameType !== 'none') {
        sl.classList.add('active');
      } else {
        sl.classList.remove('active');
      }

      this._q('#hint').textContent = hintTxt;

      if (this._bool('sharpness-bar')) {
        this._q('#sharpness-wrap').classList.add('visible');
      }
    }

    // ─────────────────────────────────────────────────────────
    // APPLY UI CONTROLS
    // ─────────────────────────────────────────────────────────
    _applyUI() {
      const showUI = this._bool('ui', true);
      const hide   = (this._attr('hide-controls', '') || '').split(',').map(s => s.trim());

      this._q('#controls').classList.toggle('hidden', !showUI);
      if (!showUI) return;

      this._q('#btn-zoom-in') .classList.toggle('hidden', hide.includes('zoom'));
      this._q('#btn-zoom-out').classList.toggle('hidden', hide.includes('zoom'));
      this._q('#btn-torch')   .classList.toggle('hidden', hide.includes('flash'));
      this._q('#btn-flip')    .classList.toggle('hidden', hide.includes('flip'));
    }

    // ─────────────────────────────────────────────────────────
    // CAMERA — START / STOP
    // ─────────────────────────────────────────────────────────
    start() {
      if (this._stream) {
        this._stream.getTracks().forEach(t => t.stop());
        this._stream = null;
        this._track  = null;
      }

      const facing = this._attr('facing', 'environment');
      const constraints = {
        audio: false,
        video: { facingMode: { ideal: facing } }
      };

      navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => this._onStream(stream))
        .catch(err   => this._onCamError(err, false));
    }

    _onStream(stream) {
      this._stream = stream;
      this._track  = stream.getVideoTracks()[0];

      const vid = this._q('video');
      vid.srcObject = stream;

      // Samsung Internet: cần load() trước play()
      vid.load();

      vid.onplaying = () => {
        this._q('#error-overlay').classList.remove('visible');
        this._updateZoomUI();

        const w = vid.videoWidth, h = vid.videoHeight;

        // Bắn event camera-ready
        this._emit('camera-ready', { width: w, height: h });
        if (typeof this.onReady === 'function') this.onReady({ width: w, height: h });

        // Bắt đầu loop nếu cần
        if (this._bool('auto-capture') || this._bool('sharpness-bar')) {
          this._startSharpnessLoop();
        }
        if (this._bool('continuous')) {
          this.startContinuous();
        }
      };

      vid.play().catch(() => {
        // Một số trình duyệt tự play — ignore an toàn
      });
    }

    _onCamError(err, wasConstraint) {
      const known = ERROR_MESSAGES[err.name] || {
        code: 'UNKNOWN', msg: 'Lỗi camera: ' + err.message, recoverable: false
      };

      // OverconstrainedError: thử lại với constraints đơn giản hơn
      if (!wasConstraint && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')) {
        navigator.mediaDevices.getUserMedia({ audio: false, video: true })
          .then(stream => this._onStream(stream))
          .catch(err2  => this._onCamError(err2, true));
        return;
      }

      // Hiện error overlay
      this._q('#error-overlay .err-msg').textContent = known.msg;
      this._q('#error-overlay').classList.add('visible');
      this._q('#btn-retry').style.display = known.recoverable ? 'block' : 'none';

      this._emit('camera-error', { code: known.code, message: known.msg, recoverable: known.recoverable });
      if (typeof this.onError === 'function') this.onError({ code: known.code, message: known.msg });
    }

    stop() {
      this.stopContinuous();
      this._stopSharpnessLoop();
      if (this._stream) {
        this._stream.getTracks().forEach(t => t.stop());
        this._stream = null;
        this._track  = null;
      }
      this._emit('camera-stop', {});
    }

    // ─────────────────────────────────────────────────────────
    // CAPTURE — Chụp ảnh
    // ─────────────────────────────────────────────────────────
    capture() {
      return new Promise((resolve, reject) => {
        const vid = this._q('video');
        if (!this._stream || vid.videoWidth === 0) {
          reject(new Error('Camera chưa sẵn sàng'));
          return;
        }

        const cvs = this._q('canvas');
        cvs.width  = vid.videoWidth;
        cvs.height = vid.videoHeight;
        const ctx  = cvs.getContext('2d');

        // Flip ngang nếu dùng camera trước
        if (this._attr('facing','environment') === 'user') {
          ctx.save();
          ctx.translate(cvs.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(vid, 0, 0);
        if (this._attr('facing','environment') === 'user') ctx.restore();

        // Áp dụng zoom vào canvas nếu digital zoom
        const zoom = this._zoom;
        let sx = 0, sy = 0, sw = cvs.width, sh = cvs.height;
        if (zoom > 1) {
          sw = Math.round(cvs.width  / zoom);
          sh = Math.round(cvs.height / zoom);
          sx = Math.round((cvs.width  - sw) / 2);
          sy = Math.round((cvs.height - sh) / 2);
        }

        // Đo sharpness trước khi crop
        const sharpness = measureSharpness(cvs, sx, sy, sw, sh);

        // Xác định vùng crop theo frame
        let cropX = sx, cropY = sy, cropW = sw, cropH = sh;
        if (this._bool('crop-to-frame', true) && this._attr('frame','square') !== 'none') {
          const r = this._getCropRect(cvs.width, cvs.height, zoom);
          cropX = r.x; cropY = r.y; cropW = r.w; cropH = r.h;
        }

        const result = processCanvas(cvs, {
          cropX, cropY, cropW, cropH,
          maxWidth : this._num('max-width', 1280),
          quality  : this._num('quality', 0.88),
          grayscale: this._bool('grayscale'),
          output   : this._attr('output', 'base64'),
        });

        const detail = {
          ...result,
          sharpness,
          frameType : this._attr('frame', 'square'),
          timestamp : Date.now(),
        };

        this._emit('camera-result', detail);
        if (typeof this.onResult === 'function') this.onResult(detail);
        resolve(detail);
      });
    }

    // Tính crop rect tương ứng với khung overlay
    _getCropRect(vidW, vidH, zoom) {
      const frameType = this._attr('frame', 'square');
      const cfg = FRAMES[frameType] || FRAMES.square;
      const size = this._num('frame-size', 85);

      const effectiveW = vidW / zoom;
      const effectiveH = vidH / zoom;
      const offsetX    = (vidW - effectiveW) / 2;
      const offsetY    = (vidH - effectiveH) / 2;

      let w, h;
      if (cfg.ar) {
        w = effectiveW * (size / 100);
        h = w / cfg.ar;
        if (h > effectiveH * 0.9) { h = effectiveH * 0.9; w = h * cfg.ar; }
      } else {
        w = effectiveW * (cfg.w / 100);
        h = effectiveH * (cfg.h / 100);
      }

      return {
        x: Math.round(offsetX + (effectiveW - w) / 2),
        y: Math.round(offsetY + (effectiveH - h) / 2),
        w: Math.round(w),
        h: Math.round(h),
      };
    }

    // ─────────────────────────────────────────────────────────
    // SHARPNESS LOOP — Real-time đo độ nét
    // ─────────────────────────────────────────────────────────
    _startSharpnessLoop() {
      this._stopSharpnessLoop();
      this._sharpTimer = setInterval(() => this._tickSharpness(), 400);
    }

    _stopSharpnessLoop() {
      if (this._sharpTimer) { clearInterval(this._sharpTimer); this._sharpTimer = null; }
      this._autoConfirm = 0;
    }

    _tickSharpness() {
      const vid = this._q('video');
      if (!this._stream || vid.videoWidth === 0) return;

      const cvs = this._q('canvas');
      cvs.width = vid.videoWidth; cvs.height = vid.videoHeight;
      cvs.getContext('2d').drawImage(vid, 0, 0);

      const zoom = this._zoom;
      let sx = 0, sy = 0, sw = cvs.width, sh = cvs.height;
      if (zoom > 1) {
        sw = Math.round(sw / zoom); sh = Math.round(sh / zoom);
        sx = Math.round((cvs.width - sw) / 2); sy = Math.round((cvs.height - sh) / 2);
      }

      const val = measureSharpness(cvs, sx, sy, sw, sh);

      // Cập nhật UI sharpness bar
      if (this._bool('sharpness-bar')) {
        this._updateSharpnessUI(val);
      }

      // Bắn event
      this._emit('sharpness-change', { value: val });
      if (typeof this.onSharpness === 'function') this.onSharpness(val);

      // Auto-capture logic
      if (this._bool('auto-capture')) {
        const threshold = this._num('sharpness-threshold', 75);
        if (val >= threshold) {
          this._autoConfirm++;
          this._updateCaptureRing(this._autoConfirm, 3);
          if (this._autoConfirm >= 3) {
            // 3 frame liên tiếp đủ nét → chụp
            this._autoConfirm = 0;
            this._stopSharpnessLoop();
            this._hideCaptureRing();
            if (!this._busy) this.capture();
          }
        } else {
          this._autoConfirm = 0;
          this._hideCaptureRing();
        }
      }
    }

    _updateSharpnessUI(val) {
      const fill  = this._q('#sharpness-fill');
      const pct   = this._q('#sharpness-pct');
      fill.style.width = val + '%';
      fill.className = val < 40 ? 'low' : val < 70 ? 'medium' : 'high';
      pct.textContent  = val + '%';
    }

    _updateCaptureRing(step, total) {
      const ring = this._q('#capture-ring');
      const circ = ring.querySelector('circle');
      ring.classList.add('visible');
      const progress  = step / total;
      const perimeter = 2 * Math.PI * 35; // r=35
      circ.style.strokeDashoffset = perimeter * (1 - progress);
    }
    _hideCaptureRing() {
      this._q('#capture-ring').classList.remove('visible');
    }

    // ─────────────────────────────────────────────────────────
    // CONTINUOUS SCAN
    // ─────────────────────────────────────────────────────────
    startContinuous() {
      this.stopContinuous();
      const ivl = this._num('continuous-interval', 2000);
      this._doCaptureBusy();
      this._autoTimer = setInterval(() => this._doCaptureBusy(), ivl);
    }

    stopContinuous() {
      if (this._autoTimer) { clearInterval(this._autoTimer); this._autoTimer = null; }
    }

    async _doCaptureBusy() {
      if (this._busy) return;
      this._busy = true;
      try { await this.capture(); }
      finally { this._busy = false; }
    }

    // ─────────────────────────────────────────────────────────
    // ZOOM — Digital zoom qua canvas crop
    // ─────────────────────────────────────────────────────────
    setZoom(val) {
      this._zoom = Math.max(1.0, Math.min(5.0, parseFloat(val) || 1));
      this._updateZoomUI();

      // Thử dùng hardware zoom nếu trình duyệt hỗ trợ (Android Chrome)
      if (this._track) {
        try {
          const caps = this._track.getCapabilities();
          if (caps.zoom) {
            const hw = caps.zoom.min + (caps.zoom.max - caps.zoom.min) * ((this._zoom - 1) / 4);
            this._track.applyConstraints({ advanced: [{ zoom: hw }] }).catch(() => {});
          }
        } catch(e) { /* iOS không hỗ trợ */ }
      }
    }
    zoomIn()  { this.setZoom(this._zoom + 0.5); }
    zoomOut() { this.setZoom(this._zoom - 0.5); }

    _updateZoomUI() {
      const zi = this._q('#zoom-indicator');
      if (this._zoom > 1.0) {
        zi.classList.add('visible');
        zi.textContent = this._zoom.toFixed(1) + '×';
      } else {
        zi.classList.remove('visible');
      }
    }

    // ─────────────────────────────────────────────────────────
    // TORCH — Đèn flash
    // ─────────────────────────────────────────────────────────
    torch(on) {
      if (!this._track) return;
      this._track.applyConstraints({ advanced: [{ torch: !!on }] })
        .then(() => {
          this._torchOn = !!on;
          this._q('#btn-torch').classList.toggle('on', this._torchOn);
        })
        .catch(() => {
          // Thiết bị không hỗ trợ torch — ẩn nút
          this._q('#btn-torch').classList.add('hidden');
        });
    }

    // ─────────────────────────────────────────────────────────
    // FLIP — Đổi camera
    // ─────────────────────────────────────────────────────────
    flip() {
      const cur = this._attr('facing', 'environment');
      this.setAttribute('facing', cur === 'environment' ? 'user' : 'environment');
      // attributeChangedCallback sẽ gọi start() lại
    }

    // ─────────────────────────────────────────────────────────
    // SET FRAME — Đổi khung lúc runtime
    // ─────────────────────────────────────────────────────────
    setFrame(frameType) {
      if (!FRAMES[frameType]) return;
      this.setAttribute('frame', frameType);
    }

    // ─────────────────────────────────────────────────────────
    // PUBLIC GETTERS
    // ─────────────────────────────────────────────────────────
    get isReady()     { return !!this._stream && this._q('video').videoWidth > 0; }
    get currentZoom() { return this._zoom; }
    get facing()      { return this._attr('facing', 'environment'); }
    getSharpness() {
      const vid = this._q('video');
      if (!this._stream || vid.videoWidth === 0) return 0;
      const cvs = this._q('canvas');
      cvs.width = vid.videoWidth; cvs.height = vid.videoHeight;
      cvs.getContext('2d').drawImage(vid, 0, 0);
      return measureSharpness(cvs, 0, 0, cvs.width, cvs.height);
    }

    // ─────────────────────────────────────────────────────────
    // EMIT CUSTOM EVENT
    // ─────────────────────────────────────────────────────────
    _emit(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ĐĂNG KÝ WEB COMPONENT
  // ─────────────────────────────────────────────────────────────
  if (!customElements.get('camera-scanner')) {
    customElements.define('camera-scanner', CameraScanner);
  }

})();
