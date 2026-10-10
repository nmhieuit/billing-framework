import { InvalidCustomerError } from './errors.js';

const CUSTOMER = /^[A-Za-z0-9_-]{1,64}$/;

export class CustomerId {
  private constructor(readonly value: string) {}

  static parse(raw: string): CustomerId {
    if (!CUSTOMER.test(raw)) {
      throw new InvalidCustomerError(`customer id must match ${CUSTOMER.source}`);
    }
    return new CustomerId(raw);
  }
}
