import * as crypto from 'crypto';
import { isAddress, zeroAddress } from 'viem';

export function validateAddress(address: string, name: string): asserts address is `0x${string}` {
  if (!isAddress(address)) {
    throw new Error(`Invalid ${name} address format: ${address}`);
  }
  if (address === zeroAddress) {
    throw new Error(`${name} address cannot be zero address`);
  }
}

export function secureRandom(): number {
  const buffer = crypto.randomBytes(4);
  return buffer.readUInt32BE(0) / 0x100000000;
}

const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

export function isValidBase64(str: string): boolean {
  if (typeof str !== 'string' || str.length === 0) {
    return false;
  }
  if (str.length % 4 !== 0) {
    return false;
  }
  return BASE64_REGEX.test(str);
}

export function decodeBase64(str: string): Uint8Array {
  if (!isValidBase64(str)) {
    throw new Error('Invalid Base64 format');
  }
  return Buffer.from(str, 'base64');
}

export function toHexAddress(value: string | null | undefined): `0x${string}` | undefined {
  if (!value) return undefined;
  if (value.startsWith('0x')) return value as `0x${string}`;
  return undefined;
}
