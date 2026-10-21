class Counter {
  #count = 0;

  constructor(readonly name: string) {}

  increment(): number {
    this.#count = this.#count + 1;
    return this.#count;
  }

  get value(): number {
    return this.#count;
  }
}

const visits = new Counter('visits');
visits.increment();
visits.increment();
console.log(visits.name, visits.value);
