export class FakeClock {
  #now: Date;

  constructor(start: Date | string) {
    this.#now = new Date(start);
  }

  now(): Date {
    return new Date(this.#now.getTime());
  }

  set(date: Date | string): void {
    this.#now = new Date(date);
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }
}
