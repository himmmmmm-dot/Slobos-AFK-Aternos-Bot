import type { RadioLine } from '../../game/events';
import { ACTIONS, type Action } from '../bindings';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

/** Turns "{jump} to vault" into text with a key cap showing whatever the action is bound to. */
export function withKeys(text: string, labelFor: (action: Action) => string): Node[] {
  const out: Node[] = [];
  for (const part of text.split(/(\{\w+\})/)) {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m && (ACTIONS as readonly string[]).includes(m[1])) out.push(h('kbd', null, labelFor(m[1] as Action)));
    else if (part) out.push(document.createTextNode(part));
  }
  return out;
}

export interface HudView {
  hp: number;
  maxHp: number;
  weaponName: string;
  mag: number;
  magSize: number;
  reserve: string;
  /** 0..1 while reloading, otherwise null. */
  reload: number | null;
  objective: string;
  count: string;
  marker: { x: number; y: number; behind: boolean; distance: number } | null;
  prompt: string | null;
  promptProgress: number;
  /** Half-gap of the crosshair in CSS pixels; it opens with the weapon's current spread. */
  crosshairGap: number;
  width: number;
  height: number;
}

export interface LogEntry extends RadioLine {
  at: number;
}

export class Hud {
  readonly el: HTMLElement;
  readonly history: LogEntry[] = [];
  subtitles = true;

  private readonly cross: HTMLElement;
  private readonly hit: HTMLElement;
  private readonly ring: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly objText: HTMLElement;
  private readonly objCount: HTMLElement;
  private readonly objBox: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly markerDist: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly promptText: HTMLElement;
  private readonly promptFill: HTMLElement;
  private readonly subs: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpNum: HTMLElement;
  private readonly vitals: HTMLElement;
  private readonly wName: HTMLElement;
  private readonly wMag: HTMLElement;
  private readonly wReserve: HTMLElement;
  private readonly wState: HTMLElement;
  private readonly perf: HTMLElement;

  private readonly queue: RadioLine[] = [];
  private lineLeft = 0;
  private hintLeft = 0;
  private hitLeft = 0;
  private clock = 0;
  private last: Partial<Record<string, string | number | boolean | null>> = {};

  constructor(private readonly labelFor: (action: Action) => string) {
    const i = (cls: string): HTMLElement => h('i', { class: cls });
    this.vignette = h('div', { class: 'vignette' });
    this.cross = h('div', { class: 'crosshair', 'aria-hidden': 'true' }, i('t'), i('b'), i('l'), i('r'), i('dot'));
    this.hit = h('div', { class: 'hitmarker', 'aria-hidden': 'true' }, i('x'), i('ring'));
    this.ring = h('div', { class: 'damage-ring', 'aria-hidden': 'true' });
    this.objText = h('span', { class: 'text' });
    this.objCount = h('span', { class: 'count' });
    this.objBox = h('div', { class: 'objective' }, h('span', { class: 'tag' }, 'Objective'), this.objText, this.objCount);
    this.markerDist = h('span');
    this.marker = h('div', { class: 'marker', 'aria-hidden': 'true' }, i('diamond'), this.markerDist);
    this.hintEl = h('div', { class: 'hint', role: 'status' });
    this.promptText = h('span');
    this.promptFill = h('i');
    this.promptEl = h('div', { class: 'prompt' }, this.promptText, h('div', { class: 'bar' }, this.promptFill));
    this.subs = h('div', { class: 'subtitles', 'aria-live': 'polite' });
    this.hpFill = h('i');
    this.hpNum = h('span', { class: 'num' });
    this.vitals = h('div', { class: 'vitals' }, h('span', { class: 'cross-icon', 'aria-hidden': 'true' }), h('div', { class: 'bar' }, this.hpFill), this.hpNum);
    this.wName = h('span', { class: 'name' });
    this.wMag = h('b');
    this.wReserve = h('small');
    this.wState = h('span', { class: 'state' });
    this.perf = h('div', { class: 'perf' });
    this.el = h(
      'div',
      { class: 'hud', hidden: '' },
      this.vignette,
      this.ring,
      this.cross,
      this.hit,
      this.marker,
      this.objBox,
      this.hintEl,
      this.promptEl,
      this.subs,
      this.vitals,
      h('div', { class: 'weapon' }, this.wName, h('span', { class: 'ammo' }, this.wMag, this.wReserve), this.wState),
      this.perf,
    );
  }

  /** Writes to the DOM only when a value actually changed. */
  private set(key: string, value: string | number | boolean | null, apply: () => void): void {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply();
  }

  reset(): void {
    this.queue.length = 0;
    this.history.length = 0;
    this.lineLeft = this.hintLeft = this.hitLeft = 0;
    this.subs.replaceChildren();
    this.hintEl.replaceChildren();
    this.hintEl.classList.remove('on');
    this.ring.replaceChildren();
    this.hit.className = 'hitmarker';
    this.last = {};
  }

  update(v: HudView): void {
    const hp = Math.max(0, Math.ceil(v.hp));
    this.set('hp', hp, () => {
      this.hpNum.textContent = String(hp);
      this.hpFill.style.width = `${(hp / v.maxHp) * 100}%`;
      const low = hp <= v.maxHp * 0.3;
      this.vitals.classList.toggle('low', low);
      this.vignette.classList.toggle('low', low && hp > 0);
    });
    this.set('wname', v.weaponName, () => (this.wName.textContent = v.weaponName));
    this.set('mag', v.mag, () => {
      this.wMag.textContent = String(v.mag);
      this.wMag.classList.toggle('empty', v.mag === 0);
    });
    this.set('reserve', v.reserve, () => (this.wReserve.textContent = ` / ${v.reserve}`));
    const state = v.reload !== null ? 'Reloading' : v.mag <= Math.ceil(v.magSize / 4) ? 'Low ammo' : '';
    this.set('wstate', state, () => (this.wState.textContent = state));
    this.set('obj', v.objective, () => (this.objText.textContent = v.objective));
    this.set('count', v.count, () => (this.objCount.textContent = v.count));
    this.set('objOn', v.objective !== '', () => (this.objBox.hidden = v.objective === ''));

    const gap = Math.round(Math.max(3, Math.min(60, v.crosshairGap)));
    this.set('gap', gap, () => this.cross.style.setProperty('--gap', `${gap}px`));

    this.set('markerOn', v.marker !== null, () => (this.marker.hidden = v.marker === null));
    if (v.marker) {
      const m = v.marker;
      const pad = 36;
      // A target behind the camera is pinned to the bottom edge on the side it lies towards.
      const x = Math.max(pad, Math.min(v.width - pad, m.behind ? v.width - m.x : m.x));
      const y = m.behind ? v.height - pad : Math.max(pad, Math.min(v.height - pad, m.y));
      this.marker.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      const dist = `${Math.round(m.distance)} m`;
      this.set('dist', dist, () => (this.markerDist.textContent = dist));
    }

    this.set('promptOn', v.prompt !== null, () => (this.promptEl.hidden = v.prompt === null));
    if (v.prompt !== null) {
      this.set('prompt', v.prompt, () => this.promptText.replaceChildren(...withKeys(v.prompt!, this.labelFor)));
      this.promptFill.style.width = `${Math.round(v.promptProgress * 100)}%`;
    }
  }

  /** Advances subtitle, hint and hit-marker timers. Not called while paused. */
  tick(dt: number): void {
    this.clock += dt;
    if (this.hitLeft > 0 && (this.hitLeft -= dt) <= 0) this.hit.className = 'hitmarker';
    if (this.hintLeft > 0 && (this.hintLeft -= dt) <= 0) this.hintEl.classList.remove('on');
    if (this.lineLeft > 0) this.lineLeft -= dt;
    if (this.lineLeft <= 0) {
      const next = this.queue.shift();
      if (next) {
        // Reading time scales with length, with a floor for very short lines.
        this.lineLeft = 1.8 + next.text.length * 0.055;
        this.subs.replaceChildren(h('p', null, h('b', null, next.speaker), next.text));
        this.subs.hidden = !this.subtitles;
      } else if (this.subs.childElementCount > 0) {
        this.subs.replaceChildren();
      }
    }
  }

  say(lines: RadioLine[]): void {
    for (const l of lines) {
      this.queue.push(l);
      this.history.push({ ...l, at: this.clock });
    }
  }

  hint(text: string): void {
    this.hintEl.replaceChildren(...withKeys(text, this.labelFor));
    this.hintEl.classList.add('on');
    this.hintLeft = 7;
  }

  /** Hit, critical and kill differ in shape, not just colour. */
  hitmarker(kind: 'hit' | 'crit' | 'kill'): void {
    this.hit.className = `hitmarker on ${kind}`;
    this.hitLeft = kind === 'kill' ? 0.32 : 0.16;
  }

  /** `angle` is where the damage came from relative to the view: 0 ahead, positive to the left. */
  damage(angle: number): void {
    const arc = h('i');
    arc.style.transform = `rotate(${(-angle * 180) / Math.PI}deg)`;
    arc.addEventListener('animationend', () => arc.remove());
    this.ring.append(arc);
    while (this.ring.childElementCount > 6) this.ring.firstElementChild!.remove();
    this.vignette.classList.remove('hurt');
    void this.vignette.offsetWidth;
    this.vignette.classList.add('hurt');
  }

  objectiveChanged(): void {
    this.objBox.classList.remove('flash');
    void this.objBox.offsetWidth;
    this.objBox.classList.add('flash');
  }

  setPerf(text: string | null): void {
    this.perf.hidden = text === null;
    if (text !== null) this.perf.textContent = text;
  }
}
