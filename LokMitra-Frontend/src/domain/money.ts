export const MAX_AMOUNT_PAISE = 1_000_000_000;

export function paiseToRupees(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error('Money must be an integer number of paise.');
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(paise / 100);
}

export function rupeesToPaise(value: string): number | null {
  const normalized = value.trim().replace(/[₹,\s]/g, '');
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) && result > 0 && result <= MAX_AMOUNT_PAISE ? result : null;
}

export function gstInPaise(subtotalPaise: number): number {
  if (!Number.isSafeInteger(subtotalPaise) || subtotalPaise < 0) throw new Error('Subtotal must be non-negative integer paise.');
  return Math.round(subtotalPaise * 18 / 100);
}
