import { TICK_DT } from './constants';

/** Converts variable frame time into whole fixed ticks plus an interpolation fraction. */
export class FixedStep {
  private acc = 0;
  alpha = 0;

  constructor(
    readonly dt = TICK_DT,
    /** Cap on catch-up ticks per frame so a long stall cannot spiral. */
    readonly maxTicks = 5,
  ) {}

  /** Returns how many ticks to run for a frame that took `frameSeconds`. */
  advance(frameSeconds: number): number {
    this.acc += Math.max(0, frameSeconds);
    let ticks = Math.floor(this.acc / this.dt + 1e-9);
    if (ticks > this.maxTicks) {
      ticks = this.maxTicks;
      this.acc = 0;
    } else {
      this.acc -= ticks * this.dt;
    }
    this.alpha = Math.min(1, Math.max(0, this.acc / this.dt));
    return ticks;
  }

  reset(): void {
    this.acc = 0;
    this.alpha = 0;
  }
}
