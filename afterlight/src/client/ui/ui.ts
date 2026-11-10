import { ACTION_LABELS, ACTIONS, cloneBindings, DEFAULT_BINDINGS, isBindable, rebind, type Action } from '../bindings';
import { LIMITS, type Quality, type Settings } from '../persistence/settings';
import { h, Hud, withKeys } from './hud';

export type ScreenName = 'loading' | 'menu' | 'settings' | 'pause' | 'log' | 'results' | 'failed' | 'error' | 'unsupported';

export interface UiCallbacks {
  start(): void;
  resume(): void;
  quit(): void;
  reload(): void;
  changeSettings(next: Settings): void;
  sound(kind: 'uiClick' | 'uiHover'): void;
}

export interface ResultStats {
  time: string;
  accuracy: string;
  crits: number;
  damageTaken: number;
}

type NumKey = 'sensitivity' | 'fov' | 'brightness' | 'hudScale' | 'masterVolume' | 'musicVolume' | 'sfxVolume' | 'dialogueVolume';
type BoolKey = 'invertY' | 'viewBob' | 'screenShake' | 'subtitles' | 'muted';

const percent = (v: number): string => `${Math.round(v * 100)}%`;

/** Menus and HUD as plain DOM over the canvas: crisp text at any resolution and real keyboard focus. */
export class UI {
  readonly hud: Hud;
  current: ScreenName | null = null;
  private readonly screens = new Map<ScreenName, HTMLElement>();
  private readonly notices: HTMLElement[] = [];
  private readonly loadFill = h('i');
  private readonly loadBar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.loadFill);
  private readonly loadStatus = h('p', { class: 'status', 'aria-live': 'polite' });
  private readonly errorDetail = h('p', { class: 'detail' });
  private readonly resultList = h('dl', { class: 'stats' });
  private readonly settingsBody = h('div', { class: 'settings-body' });
  private readonly logBody = h('div', { class: 'log-body' });
  private readonly bindNote = h('p', { class: 'notice', role: 'status' });
  private back: ScreenName = 'menu';
  private capturing: Action | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: UiCallbacks,
    private readonly getSettings: () => Settings,
    private readonly keyName: (code: string) => string,
  ) {
    this.hud = new Hud((a) => this.actionKey(a));
    root.append(this.hud.el);
    this.build();
    root.addEventListener('keydown', (e) => this.onNavKey(e));
    // Capture phase, so a key being assigned never also reaches the game or the menus.
    window.addEventListener('keydown', (e) => this.onCaptureKey(e), true);
    window.addEventListener('mousedown', (e) => this.onCaptureMouse(e), true);
  }

  private actionKey(a: Action): string {
    const code = this.getSettings().bindings[a][0];
    return code ? this.keyName(code) : '—';
  }

  private button(label: string, onClick: () => void, cls = '', sub = ''): HTMLButtonElement {
    const b = h('button', { type: 'button', class: cls }, label, sub && h('small', null, sub));
    b.addEventListener('click', () => {
      this.cb.sound('uiClick');
      onClick();
    });
    b.addEventListener('mouseenter', () => this.cb.sound('uiHover'));
    return b;
  }

  private logo(): HTMLElement {
    return h('h1', { class: 'logo' }, 'AFTERLIGHT', h('span', null, 'BLACKOUT'));
  }

  private notice(): HTMLElement {
    const n = h('p', { class: 'notice', role: 'status' });
    this.notices.push(n);
    return n;
  }

  private screen(name: ScreenName, ...children: (Node | string)[]): void {
    const s = h('section', { class: `screen ${name}`, hidden: '' }, h('div', { class: 'panel' }, ...children));
    this.screens.set(name, s);
    this.root.append(s);
  }

  private controlsStrip(): HTMLElement {
    const text = '{forward}{left}{back}{right} move · mouse look · {fire} fire · {reload} reload · {sprint} sprint · {crouch} crouch · {jump} jump · {interact} interact · {pause} pause';
    return h('p', { class: 'controls-strip' }, ...withKeys(text, (a) => this.actionKey(a)));
  }

  private build(): void {
    this.screen('loading', this.logo(), this.loadBar, this.loadStatus);
    this.screen(
      'menu',
      this.logo(),
      h('p', { class: 'tagline' }, 'The city went dark. Find out why.'),
      h(
        'nav',
        null,
        this.button('Start mission', () => this.cb.start(), 'primary', 'Dead Signal · concourse'),
        this.button('Settings', () => this.openSettings('menu')),
      ),
      h('div', { class: 'controls-slot' }),
      this.notice(),
      h('p', { class: 'build' }, 'Foundation build 0.1.0. One graybox encounter; the campaign and online play are not in this build.'),
    );
    this.screen(
      'pause',
      h('h2', null, 'Paused'),
      h(
        'nav',
        null,
        this.button('Resume', () => this.cb.resume(), 'primary'),
        this.button('Restart mission', () => this.cb.start()),
        this.button('Settings', () => this.openSettings('pause')),
        this.button('Comms log', () => this.openLog()),
        this.button('Quit to menu', () => this.cb.quit()),
      ),
      this.notice(),
    );
    this.screen('settings', h('h2', null, 'Settings'), this.settingsBody, h('nav', { class: 'row-nav' }, this.button('Back', () => this.show(this.back), 'primary')));
    this.screen('log', h('h2', null, 'Comms log'), this.logBody, h('nav', { class: 'row-nav' }, this.button('Back', () => this.show('pause'), 'primary')));
    this.screen(
      'results',
      h('h2', null, 'Relay restored'),
      h('p', null, "Ilan's transmission is on the air again."),
      this.resultList,
      h('nav', null, this.button('Replay', () => this.cb.start(), 'primary'), this.button('Main menu', () => this.cb.quit())),
    );
    this.screen(
      'failed',
      h('h2', null, 'Signal lost'),
      h('p', null, 'Mara is down and the concourse is still held.'),
      h('nav', null, this.button('Retry', () => this.cb.start(), 'primary'), this.button('Main menu', () => this.cb.quit())),
      this.notice(),
    );
    this.screen(
      'error',
      h('h2', null, 'The game hit a problem'),
      this.errorDetail,
      h('nav', null, this.button('Reload the game', () => this.cb.reload(), 'primary')),
    );
    this.screen(
      'unsupported',
      this.logo(),
      h('h2', null, 'Keyboard and mouse required'),
      h('p', null, 'AFTERLIGHT: BLACKOUT is a desktop first-person shooter. Touch controls are not part of this release, so it cannot be played on this device.'),
    );
  }

  /** Shows one screen, or none while playing. Moves keyboard focus to its main action. */
  show(name: ScreenName | null): void {
    this.capturing = null;
    this.current = name;
    for (const [n, el] of this.screens) el.hidden = n !== name;
    if (!name) return;
    if (name === 'menu') {
      const slot = this.screens.get('menu')!.querySelector('.controls-slot')!;
      slot.replaceChildren(this.controlsStrip());
    }
    const el = this.screens.get(name)!;
    (el.querySelector<HTMLElement>('button.primary') ?? el.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }

  setHudVisible(on: boolean): void {
    this.hud.el.hidden = !on;
  }

  applySettings(s: Settings): void {
    this.root.style.setProperty('--hud-scale', String(s.hudScale));
    this.hud.subtitles = s.subtitles;
  }

  /** Progress is the share of real loading steps finished; it never advances on a timer. */
  setLoading(fraction: number, label: string): void {
    const pct = Math.round(fraction * 100);
    this.loadFill.style.width = `${pct}%`;
    this.loadBar.setAttribute('aria-valuenow', String(pct));
    this.loadStatus.textContent = label;
  }

  setNotice(text: string): void {
    for (const n of this.notices) {
      n.textContent = text;
      n.hidden = text === '';
    }
  }

  showError(detail: string): void {
    this.errorDetail.textContent = detail;
    this.show('error');
  }

  showResults(stats: ResultStats): void {
    const row = (k: string, v: string): Node[] => [h('dt', null, k), h('dd', null, v)];
    this.resultList.replaceChildren(
      ...row('Time', stats.time),
      ...row('Accuracy', stats.accuracy),
      ...row('Critical hits', String(stats.crits)),
      ...row('Damage taken', String(stats.damageTaken)),
    );
    this.show('results');
  }

  private openLog(): void {
    const lines = this.hud.history;
    this.logBody.replaceChildren(
      ...(lines.length
        ? lines.map((l) => h('p', null, h('b', null, l.speaker), l.text))
        : [h('p', { class: 'dim' }, 'No transmissions yet.')]),
    );
    this.show('log');
  }

  private openSettings(from: ScreenName): void {
    this.back = from;
    this.renderSettings();
    this.show('settings');
  }

  private renderSettings(): void {
    const s = this.getSettings();
    const change = (patch: Partial<Settings>): void => this.cb.changeSettings({ ...this.getSettings(), ...patch });

    const range = (label: string, key: NumKey, min: number, max: number, step: number, fmt: (v: number) => string): HTMLElement => {
      const id = `set-${key}`;
      const out = h('output', { for: id }, fmt(s[key]));
      const input = h('input', { type: 'range', id, min: String(min), max: String(max), step: String(step), value: String(s[key]) });
      input.addEventListener('input', () => {
        out.textContent = fmt(Number(input.value));
        change({ [key]: Number(input.value) });
      });
      return h('div', { class: 'row' }, h('label', { for: id }, label), input, out);
    };
    const check = (label: string, key: BoolKey): HTMLElement => {
      const id = `set-${key}`;
      const input = h('input', { type: 'checkbox', id });
      input.checked = s[key];
      input.addEventListener('change', () => change({ [key]: input.checked }));
      return h('div', { class: 'row' }, h('label', { for: id }, label), input, h('span'));
    };
    const quality = h('select', { id: 'set-quality' });
    for (const q of ['low', 'medium', 'high'] as Quality[]) {
      const opt = h('option', { value: q }, q[0].toUpperCase() + q.slice(1));
      opt.selected = s.quality === q;
      quality.append(opt);
    }
    quality.addEventListener('change', () => change({ quality: quality.value as Quality }));

    const binds = h('div', { class: 'binds' });
    for (const a of ACTIONS) {
      const waiting = this.capturing === a;
      const btn = h('button', { type: 'button', class: waiting ? 'bind waiting' : 'bind' }, waiting ? 'Press a key…' : s.bindings[a].map(this.keyName).join(' / '));
      btn.addEventListener('click', () => {
        this.capturing = a;
        this.bindNote.textContent = 'Press a key or mouse button. Escape cancels.';
        this.renderSettings();
      });
      binds.append(h('div', { class: 'row' }, h('span', { class: 'label' }, ACTION_LABELS[a]), btn, h('span')));
    }

    this.settingsBody.replaceChildren(
      h('h3', null, 'Mouse and view'),
      range('Mouse sensitivity', 'sensitivity', LIMITS.sensitivity[0], LIMITS.sensitivity[1], 0.05, (v) => v.toFixed(2)),
      check('Invert vertical look', 'invertY'),
      range('Field of view', 'fov', LIMITS.fov[0], LIMITS.fov[1], 1, (v) => `${v}°`),
      check('Weapon and view bob', 'viewBob'),
      check('Screen shake when hit', 'screenShake'),
      h('h3', null, 'Graphics and interface'),
      h('div', { class: 'row' }, h('label', { for: 'set-quality' }, 'Graphics quality'), quality, h('span')),
      range('Brightness', 'brightness', LIMITS.brightness[0], LIMITS.brightness[1], 0.05, percent),
      range('HUD size', 'hudScale', LIMITS.hudScale[0], LIMITS.hudScale[1], 0.05, percent),
      check('Subtitles', 'subtitles'),
      h('h3', null, 'Audio'),
      check('Mute all sound', 'muted'),
      range('Master volume', 'masterVolume', 0, 1, 0.05, percent),
      range('Music', 'musicVolume', 0, 1, 0.05, percent),
      range('Effects', 'sfxVolume', 0, 1, 0.05, percent),
      range('Radio', 'dialogueVolume', 0, 1, 0.05, percent),
      h('h3', null, 'Controls'),
      binds,
      this.bindNote,
      h(
        'div',
        { class: 'row-nav' },
        this.button('Reset controls', () => {
          this.capturing = null;
          this.bindNote.textContent = 'Controls reset to defaults.';
          change({ bindings: cloneBindings(DEFAULT_BINDINGS) });
          this.renderSettings();
        }),
      ),
    );
    if (this.capturing) this.settingsBody.querySelector<HTMLElement>('.bind.waiting')?.focus({ preventScroll: true });
  }

  private assign(code: string): void {
    const action = this.capturing;
    if (!action) return;
    this.capturing = null;
    if (code === 'Escape') this.bindNote.textContent = 'Cancelled.';
    else if (!isBindable(code)) this.bindNote.textContent = `${this.keyName(code)} is reserved by the browser and cannot be used.`;
    else {
      this.cb.changeSettings({ ...this.getSettings(), bindings: rebind(this.getSettings().bindings, action, code) });
      this.bindNote.textContent = `${ACTION_LABELS[action]} is now ${this.keyName(code)}.`;
    }
    this.renderSettings();
    this.settingsBody.querySelectorAll<HTMLElement>('.bind')[ACTIONS.indexOf(action)]?.focus({ preventScroll: true });
  }

  private onCaptureKey(e: KeyboardEvent): void {
    if (!this.capturing) return;
    e.preventDefault();
    e.stopPropagation();
    this.assign(e.code);
  }

  private onCaptureMouse(e: MouseEvent): void {
    if (!this.capturing) return;
    e.preventDefault();
    e.stopPropagation();
    this.assign(`Mouse${e.button}`);
  }

  /** Arrow keys move between buttons; Escape backs out of sub-screens. Tab works everywhere as usual. */
  private onNavKey(e: KeyboardEvent): void {
    if (!this.current || this.capturing) return;
    if (e.key === 'Escape' && (this.current === 'settings' || this.current === 'log')) {
      e.preventDefault();
      this.show(this.current === 'settings' ? this.back : 'pause');
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active.tagName !== 'BUTTON' && active.tagName !== 'BODY') return;
    const items = [...this.screens.get(this.current)!.querySelectorAll<HTMLElement>('button')];
    if (items.length === 0) return;
    e.preventDefault();
    const i = active ? items.indexOf(active) : -1;
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  }
}
