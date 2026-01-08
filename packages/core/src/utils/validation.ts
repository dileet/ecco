import { z } from 'zod';

export function safeJsonParse<T>(json: string, schema?: z.ZodType<T>): T | null {
  try {
    const parsed = JSON.parse(json);
    if (schema) {
      const result = schema.safeParse(parsed);
      return result.success ? result.data : null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export function safeParseFloat(value: string): number | null {
  const parsed = parseFloat(value);
  if (isNaN(parsed) || !isFinite(parsed)) {
    return null;
  }
  return parsed;
}

export function safeParseInt(value: string, radix = 10): number | null {
  const parsed = parseInt(value, radix);
  if (isNaN(parsed)) {
    return null;
  }
  return parsed;
}

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidSemver(version: string): boolean {
  if (typeof version !== 'string' || version.length === 0) {
    return false;
  }
  const match = version.match(SEMVER_REGEX);
  if (!match) {
    return false;
  }
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = parseInt(match[3], 10);
  if (major < 0 || minor < 0 || patch < 0) {
    return false;
  }
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return false;
  }
  return true;
}

export function parseSemver(version: string): { major: number; minor: number; patch: number; prerelease?: string } | null {
  if (!isValidSemver(version)) {
    return null;
  }
  const match = version.match(SEMVER_REGEX);
  if (!match) {
    return null;
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
  };
}

export function isValidUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

export function isValidMultiaddr(addr: string): boolean {
  if (typeof addr !== 'string' || addr.length === 0) {
    return false;
  }
  if (!addr.startsWith('/')) {
    return false;
  }
  const parts = addr.slice(1).split('/');
  if (parts.length < 2) {
    return false;
  }
  return true;
}

export function clamp(value: number, min: number, max: number): number {
  if (isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value) && value > 0;
}

export function validateArrayBounds<T>(arr: T[], index: number): T | undefined {
  if (!Array.isArray(arr) || index < 0 || index >= arr.length) {
    return undefined;
  }
  return arr[index];
}

export function ensureNonEmptyArray<T>(arr: T[], name: string): asserts arr is [T, ...T[]] {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
}

export function validateRange(value: number, min: number, max: number, name: string): void {
  if (isNaN(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  }
}
