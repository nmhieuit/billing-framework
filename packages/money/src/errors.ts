export class InvalidMoneyError extends Error {
  override name = 'InvalidMoneyError';
}

export class CurrencyMismatchError extends Error {
  override name = 'CurrencyMismatchError';
}
