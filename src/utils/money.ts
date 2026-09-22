/** All amounts in the system are integer kobo. ₦1 = 100 kobo. */

export function nairaToKobo(naira: number): bigint {
  if (!Number.isFinite(naira) || naira < 0) {
    throw new Error('Invalid naira amount');
  }
  return BigInt(Math.round(naira * 100));
}

export function koboToNairaNumber(kobo: bigint | number): number {
  return Number(kobo) / 100;
}

export function formatKobo(kobo: bigint | number): string {
  const naira = koboToNairaNumber(kobo);
  return naira.toLocaleString('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
  });
}

export function parseUserAmountToKobo(raw: string): bigint | null {
  const cleaned = raw.replace(/[₦,\s]/g, '');
  const naira = Number(cleaned);
  if (!Number.isFinite(naira) || naira <= 0 || !Number.isInteger(naira)) {
    return null;
  }
  return nairaToKobo(naira);
}