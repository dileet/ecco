import * as crypto from 'crypto';

export function secureRandom(): number {
  const buffer = crypto.randomBytes(4);
  return buffer.readUInt32BE(0) / 0x100000000;
}
