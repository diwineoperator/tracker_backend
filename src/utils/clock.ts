/** Time source. The server clock is authoritative; tests inject a fake. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
