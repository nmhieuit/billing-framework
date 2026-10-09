export class InvalidChargeError extends Error {
  override name = 'InvalidChargeError';
}

export class StateTransitionError extends Error {
  override name = 'StateTransitionError';
}
