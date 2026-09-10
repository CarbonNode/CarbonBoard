// The switch confirmation — a Cortex toast, bottom-right, drawn by us.
//
// WHY NOT THE EXISTING CortexToast: that tray app is a fine notifier, but it
// works by POLLING the gateway's push ledger every ~8s, and a push reaches every
// phone in the org. Neither is right for "I just pressed a key and want to know
// which mic I'm on" — that has to be instant, local, and silent everywhere else.
// So this draws the same face CortexToast draws, from inside the app that
// actually did the switching.
//
// The look is deliberately its Win95 terminal chrome — grey face, navy gradient
// title, phosphor-green Consolas on black — because that IS what a Cortex
// notification looks like on this machine. A tasteful dark-brand card would be
// prettier and would read as a different product.

import { BrowserWindow, screen } from 'electron';

let toastWin: BrowserWindow | null = null;
let hideTimer: NodeJS.Timeout | null = null;

const W = 380;
const H = 132;

/** Win95 palette, matched to CortexToast.ps1 so the two are one thing. */
const FACE = '#c0c0c0';
const SHADOW = '#808080';
const TITLE_A = '#000080';
const TITLE_B = '#1084d0';
const TERM_BG = '#000000';
const TERM_FG = '#00ff66';
const TERM_DIM = '#00a040';

/**
 * A glyph for the kind of thing you just switched to, picked from the device
 * name. Inline SVG rather than a bundled PNG: it is drawn once at one size, it
 * has to sit on a black terminal panel in phosphor green, and shipping four
 * images to tint them would be worse in every way.
 */
function deviceGlyph(profile: string, output: string | null): string {
  const hay = `${profile} ${output ?? ''}`.toLowerCase();
  const speaker = /speaker|desktop|monitor|tv/.test(hay);
  const earbud = /in ear|earbud|cetra|buds|wireless/.test(hay);
  const stroke = `fill="none" stroke="${TERM_FG}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"`;

  if (speaker) {
    return `<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
      <rect x="7" y="3" width="18" height="26" rx="3" ${stroke}/>
      <circle cx="16" cy="20" r="5" ${stroke}/>
      <circle cx="16" cy="9" r="2" ${stroke}/>
    </svg>`;
  }
  if (earbud) {
    return `<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
      <path d="M11 12a5 5 0 1 1 5 5v6" ${stroke}/>
      <path d="M21 12a5 5 0 1 0-5 5" ${stroke}/>
      <circle cx="11" cy="12" r="3.2" ${stroke}/>
      <circle cx="21" cy="12" r="3.2" ${stroke}/>
    </svg>`;
  }
  // Default: a headset, which is what most of these profiles are.
  return `<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
    <path d="M6 20v-4a10 10 0 0 1 20 0v4" ${stroke}/>
    <rect x="3" y="19" width="6" height="9" rx="2.5" ${stroke}/>
    <rect x="23" y="19" width="6" height="9" rx="2.5" ${stroke}/>
    <path d="M26 28a4 4 0 0 1-4 4h-4" ${stroke}/>
  </svg>`;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Long device names have to fit one line without pushing the panel around. */
const clip = (s: string, n = 34): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function html(profile: string, mic: string | null, output: string | null): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;
    -webkit-user-select:none;cursor:default}
  /* The classic raised bevel: white top/left, mid-grey then black bottom/right. */
  .win{width:${W - 2}px;height:${H - 2}px;box-sizing:border-box;background:${FACE};
    border:1px solid #000;box-shadow:inset 1px 1px 0 #fff, inset -1px -1px 0 ${SHADOW};
    font-family:Tahoma,'Segoe UI',sans-serif}
  .bar{height:20px;display:flex;align-items:center;gap:6px;padding:0 4px 0 5px;
    background:linear-gradient(90deg,${TITLE_A},${TITLE_B});color:#fff;
    font-size:11px;font-weight:700;letter-spacing:.2px}
  .bar .x{margin-left:auto;width:16px;height:14px;background:${FACE};color:#000;
    display:flex;align-items:center;justify-content:center;font-size:10px;
    box-shadow:inset 1px 1px 0 #fff, inset -1px -1px 0 ${SHADOW};border:1px solid #000}
  .term{margin:5px;height:${H - 2 - 20 - 10}px;background:${TERM_BG};
    box-shadow:inset 1px 1px 0 ${SHADOW};display:flex;gap:11px;align-items:center;
    padding:0 11px;box-sizing:border-box}
  .glyph{flex:0 0 auto;display:flex;align-items:center;justify-content:center}
  .lines{min-width:0;font-family:Consolas,'Courier New',monospace;line-height:1.45}
  .k{color:${TERM_FG};font-size:12px;font-weight:700;letter-spacing:.4px}
  .name{color:${TERM_FG};font-size:15px;font-weight:700;margin-top:1px}
  .row{color:${TERM_DIM};font-size:11px;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis}
  .row b{color:${TERM_FG};font-weight:400}
  </style></head><body>
  <div class="win">
    <div class="bar"><span>Carbon Cortex</span><span class="x">×</span></div>
    <div class="term">
      <div class="glyph">${deviceGlyph(profile, output)}</div>
      <div class="lines">
        <div class="k">&gt; AUDIO DEVICE SWITCHED</div>
        <div class="name">${esc(profile)}</div>
        ${output ? `<div class="row">out <b>${esc(clip(output))}</b></div>` : ''}
        ${mic ? `<div class="row">mic <b>${esc(clip(mic))}</b></div>` : ''}
      </div>
    </div>
  </div></body></html>`;
}

/**
 * Show the toast. Reuses one window: a profile key can be pressed three times in
 * a second while you find the right headset, and three stacked toasts fighting
 * for the same corner is worse than none.
 */
export function showAudioToast(
  profile: string,
  mic: string | null,
  output: string | null,
  ms = 3200,
): void {
  try {
    if (!toastWin || toastWin.isDestroyed()) {
      toastWin = new BrowserWindow({
        width: W,
        height: H,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // Never take focus. This fires while you are mid-game or mid-call, and a
        // notification that steals the keyboard for even one frame is a bug.
        focusable: false,
        show: false,
        hasShadow: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      // Above full-screen games too — the moment you most need to know which mic
      // is live is the moment something else owns the screen.
      toastWin.setAlwaysOnTop(true, 'screen-saver');
      toastWin.setVisibleOnAllWorkspaces(true);
      toastWin.on('closed', () => { toastWin = null; });
    }

    // Re-read the work area every time: the toast has to land on the CURRENT
    // primary display, and this machine's monitors change with the profile.
    const wa = screen.getPrimaryDisplay().workArea;
    toastWin.setBounds({
      x: Math.round(wa.x + wa.width - W - 14),
      y: Math.round(wa.y + wa.height - H - 14),
      width: W,
      height: H,
    });

    void toastWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(profile, mic, output))}`);
    toastWin.showInactive();

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
    }, ms);
  } catch (err) {
    // A notification is never worth taking the app down for.
    console.error('[toast]', err);
  }
}
