export function bigintToDecimalString(value: bigint): string {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) * 10n ** 18n) {
    console.warn(`bigintToDecimalString: value ${value} may lose precision when converted to string`)
  }
  const str = value.toString()
  const padded = str.padStart(19, '0')
  const intPart = padded.slice(0, -18) || '0'
  const fracPart = padded.slice(-18).replace(/0+$/, '')
  return fracPart ? `${intPart}.${fracPart}` : intPart
}

export function toWei(value: string | bigint): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new Error('toWei: value cannot be negative')
    }
    return value
  }
  if (value.startsWith('-')) {
    throw new Error('toWei: value cannot be negative')
  }
  const [intPart, fracPart = ''] = value.split('.')
  const paddedFrac = fracPart.padEnd(18, '0').slice(0, 18)
  return BigInt(intPart + paddedFrac)
}

export function toWeiOrBigint(value: string | bigint): bigint {
  return typeof value === 'bigint' ? value : toWei(value)
}

export function validateMilestonesTotal(
  milestones: Array<{ amount: string | bigint }>,
  totalAmount: string | bigint
): void {
  const total = toWeiOrBigint(totalAmount)
  const sum = milestones.reduce((acc, m) => acc + toWeiOrBigint(m.amount), 0n)
  if (sum !== total) {
    throw new Error(`Milestones sum (${sum}) does not equal total amount (${total})`)
  }
}

export function validateStreamingRate(rate: string | bigint | undefined): void {
  if (!rate) return
  const rateWei = toWeiOrBigint(rate)
  if (rateWei <= 0n) {
    throw new Error('Streaming rate must be greater than 0')
  }
}

export function validateEscrowAmounts(milestones: Array<{ amount: string | bigint }>): void {
  for (const m of milestones) {
    const amount = toWeiOrBigint(m.amount)
    if (amount <= 0n) {
      throw new Error('Escrow milestone amounts must be greater than 0')
    }
  }
}
