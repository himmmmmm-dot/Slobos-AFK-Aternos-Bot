import type { TickInput } from '../game/sim';
import type { Action } from './bindings';
import type { Settings } from './persistence/settings';

export interface InputHandlers {
  onLockChange(locked: boolean): void;
  onLockError(): void;
  onPause(): void;
}

/** Radians of view rotation per pixel of mouse travel at sensitivity 1. */
const LOOK_SCALE = 0.0022;
const MAX_PITCH = 1.5;
/** Browsers occasionally report one enormous delta when pointer lock engages; ignore those. */
const MAX_DELTA = 400;

/** Keyboard, mouse and pointer-lock handling. Owns the view angles; the simulation only reads them. */
export class Input {
  yaw = 0;
  pitch = 0;
  /** True while the game owns the keyboard and mouse; false while menus do. */
  capture = false;
  locked = false;
  private swayX = 0;
  private swayY = 0;
  private readonly down = new Set<string>();
  /** Keys pressed since the last sample, so a tap shorter than one frame still registers. */
  private readonly tapped = new Set<string>();
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly getSettings: () => Settings,
    private readonly handlers: InputHandlers,
    /** Automation only: play without pointer lock, so scripted input does not depend on lock timing. */
    private readonly noLock = false,
  ) {}

  attach(): void {
    const on = (target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(window, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    on(window, 'keyup', (e: KeyboardEvent) => this.down.delete(e.code));
    on(this.el, 'mousedown', (e: MouseEvent) => {
      if (!this.capture) return;
      e.preventDefault();
      this.press(`Mouse${e.button}`);
    });
    on(window, 'mouseup', (e: MouseEvent) => this.down.delete(`Mouse${e.button}`));
    on(document, 'mousemove', (e: MouseEvent) => this.onMouseMove(e));
    on(this.el, 'contextmenu', (e: Event) => e.preventDefault());
    on(this.el, 'wheel', (e: Event) => this.capture && e.preventDefault(), { passive: false });
    on(document, 'pointerlockchange', () => {
      if (this.noLock) return;
      this.locked = document.pointerLockElement === this.el;
      this.handlers.onLockChange(this.locked);
    });
    on(document, 'pointerlockerror', () => this.handlers.onLockError());
    on(window, 'blur', () => this.clear());
  }

  dispose(): void {
    for (const off of this.cleanup) off();
    this.cleanup.length = 0;
    this.clear();
  }

  /** Must be called from a user gesture. The result arrives through onLockChange or onLockError. */
  requestLock(): void {
    if (this.noLock) {
      this.locked = true;
      this.handlers.onLockChange(true);
      return;
    }
    if (document.pointerLockElement === this.el) {
      this.handlers.onLockChange(true);
      return;
    }
    try {
      // Raw input skips OS pointer acceleration where the browser supports it.
      const p = this.el.requestPointerLock({ unadjustedMovement: true }) as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        const q = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
        q?.catch?.(() => this.handlers.onLockError());
      });
    } catch {
      this.handlers.onLockError();
    }
  }

  exitLock(): void {
    if (this.noLock) {
      if (!this.locked) return;
      this.locked = false;
      this.handlers.onLockChange(false);
      return;
    }
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }

  /** Forgets every held key and button, so nothing stays stuck after focus is lost. */
  clear(): void {
    this.down.clear();
    this.tapped.clear();
    this.swayX = this.swayY = 0;
  }

  private press(code: string): void {
    this.down.add(code);
    this.tapped.add(code);
  }

  private held(action: Action): boolean {
    for (const code of this.getSettings().bindings[action]) if (this.down.has(code) || this.tapped.has(code)) return true;
    return false;
  }

  /** Input for one simulation tick. A latched tap is reported for exactly one tick. */
  sample(): TickInput {
    const input: TickInput = {
      moveX: (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0),
      moveZ: (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.held('jump'),
      sprint: this.held('sprint'),
      crouch: this.held('crouch'),
      fire: this.held('fire'),
      reload: this.held('reload'),
      interact: this.held('interact'),
    };
    this.tapped.clear();
    return input;
  }

  /** Mouse travel since the last call, in pixels, for weapon sway. */
  takeSway(): { x: number; y: number } {
    const s = { x: this.swayX, y: this.swayY };
    this.swayX = this.swayY = 0;
    return s;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const bindings = this.getSettings().bindings;
    if (bindings.pause.includes(e.code) && !e.repeat) {
      const t = e.target as HTMLElement | null;
      if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'SELECT')) {
        e.preventDefault();
        this.handlers.onPause();
        return;
      }
    }
    if (!this.capture) return;
    // While playing, keep keys such as Space, Tab and the arrows from scrolling or moving focus.
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    if (!e.repeat) this.press(e.code);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.capture || !this.locked) return;
    const dx = e.movementX;
    const dy = e.movementY;
    if (Math.abs(dx) > MAX_DELTA || Math.abs(dy) > MAX_DELTA) return;
    const s = this.getSettings();
    const k = LOOK_SCALE * s.sensitivity;
    this.yaw -= dx * k;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + dy * k * (s.invertY ? 1 : -1)));
    this.swayX += dx;
    this.swayY += dy;
  }
}
