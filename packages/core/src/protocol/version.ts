import type { ProtocolVersion } from '../types';

const VERSION_PART_REGEX = /^(0|[1-9]\d*)$/;

export function parseVersion(versionString: string): ProtocolVersion {
  if (typeof versionString !== 'string' || versionString.length === 0) {
    throw new Error(`Invalid version string: ${versionString}`);
  }
  const parts = versionString.split('.');
  if (parts.length !== 3) {
    throw new Error(`Invalid version string: ${versionString}`);
  }
  for (const part of parts) {
    if (!VERSION_PART_REGEX.test(part)) {
      throw new Error(`Invalid version string: ${versionString}`);
    }
  }
  const [major, minor, patch] = parts.map((p) => parseInt(p, 10));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    throw new Error(`Version number out of bounds: ${versionString}`);
  }
  return { major, minor, patch };
}

export function formatVersion(version: ProtocolVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareVersions(a: ProtocolVersion, b: ProtocolVersion): -1 | 0 | 1 {
  if (a.major !== b.major) {
    return a.major > b.major ? 1 : -1;
  }
  if (a.minor !== b.minor) {
    return a.minor > b.minor ? 1 : -1;
  }
  if (a.patch !== b.patch) {
    return a.patch > b.patch ? 1 : -1;
  }
  return 0;
}

export function isMajorBreaking(a: ProtocolVersion, b: ProtocolVersion): boolean {
  return a.major !== b.major;
}

export interface VersionCompatibilityResult {
  compatible: boolean;
  reason?: string;
}

export function isCompatible(
  peerVersion: ProtocolVersion,
  minVersion: ProtocolVersion
): VersionCompatibilityResult {
  if (peerVersion.major < minVersion.major) {
    return {
      compatible: false,
      reason: `Major version ${peerVersion.major} is below minimum ${minVersion.major}`,
    };
  }

  if (peerVersion.major > minVersion.major) {
    return { compatible: true };
  }

  if (peerVersion.minor < minVersion.minor) {
    return {
      compatible: false,
      reason: `Minor version ${peerVersion.minor} is below minimum ${minVersion.minor}`,
    };
  }

  if (peerVersion.minor > minVersion.minor) {
    return { compatible: true };
  }

  if (peerVersion.patch < minVersion.patch) {
    return {
      compatible: false,
      reason: `Patch version ${peerVersion.patch} is below minimum ${minVersion.patch}`,
    };
  }

  return { compatible: true };
}

export function meetsMinimumVersion(
  version: ProtocolVersion,
  minVersion: ProtocolVersion
): boolean {
  return compareVersions(version, minVersion) >= 0;
}
