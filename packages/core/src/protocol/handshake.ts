import type {
  Message,
  ProtocolVersion,
  ProtocolConfig,
  VersionHandshakePayload,
  VersionHandshakeResponse,
  VersionIncompatibleNotice,
  ConstitutionHash,
} from '../types';
import type { NetworkConfig } from '../networks';
import { isCompatible, formatVersion } from './version';
import { computeConstitutionHash, validateConstitution, parseConstitutionHash } from './constitution';

export const HANDSHAKE_TIMEOUT_MS = 5000;
export const DISCONNECT_DELAY_MS = 1000;

export async function createHandshakeMessage(
  fromPeerId: string,
  toPeerId: string,
  networkConfig: NetworkConfig
): Promise<Message> {
  const constitutionHash = await computeConstitutionHash(networkConfig.constitution);

  const payload: VersionHandshakePayload = {
    protocolVersion: networkConfig.protocol.currentVersion,
    networkId: networkConfig.networkId,
    timestamp: Date.now(),
    constitutionHash,
  };

  return {
    id: crypto.randomUUID(),
    from: fromPeerId,
    to: toPeerId,
    type: 'version-handshake',
    payload,
    timestamp: Date.now(),
  };
}

export async function createHandshakeResponse(
  fromPeerId: string,
  toPeerId: string,
  networkConfig: NetworkConfig,
  peerVersion: ProtocolVersion,
  peerConstitutionHash: ConstitutionHash,
  requestId: string
): Promise<Message> {
  const protocolConfig = networkConfig.protocol;
  const compatibility = isCompatible(peerVersion, protocolConfig.minVersion);

  const localConstitutionHash = await computeConstitutionHash(networkConfig.constitution);
  const constitutionValidation = validateConstitution(localConstitutionHash, peerConstitutionHash);

  const versionAccepted = compatibility.compatible || protocolConfig.enforcementLevel === 'none';
  const constitutionAccepted = constitutionValidation.valid;
  const accepted = versionAccepted && constitutionAccepted;

  let reason = compatibility.reason;
  if (!constitutionAccepted) {
    reason = constitutionValidation.reason;
  }

  const payload: VersionHandshakeResponse = {
    accepted,
    protocolVersion: protocolConfig.currentVersion,
    minProtocolVersion: protocolConfig.minVersion,
    reason,
    upgradeUrl: protocolConfig.upgradeUrl,
    constitutionMismatch: !constitutionAccepted,
  };

  return {
    id: requestId,
    from: fromPeerId,
    to: toPeerId,
    type: 'version-handshake-response',
    payload,
    timestamp: Date.now(),
  };
}

export function validatePeerVersion(
  peerVersion: ProtocolVersion,
  protocolConfig: ProtocolConfig
): VersionHandshakeResponse {
  const compatibility = isCompatible(peerVersion, protocolConfig.minVersion);

  const accepted =
    protocolConfig.enforcementLevel === 'strict'
      ? compatibility.compatible
      : true;

  return {
    accepted,
    protocolVersion: protocolConfig.currentVersion,
    minProtocolVersion: protocolConfig.minVersion,
    reason: compatibility.reason,
    upgradeUrl: protocolConfig.upgradeUrl,
  };
}

export function createIncompatibleNotice(
  fromPeerId: string,
  toPeerId: string,
  protocolConfig: ProtocolConfig,
  peerVersion: ProtocolVersion
): Message {
  const payload: VersionIncompatibleNotice = {
    requiredMinVersion: protocolConfig.minVersion,
    yourVersion: peerVersion,
    upgradeUrl: protocolConfig.upgradeUrl,
    message: `Your protocol version ${formatVersion(peerVersion)} is incompatible with this network. Minimum required: ${formatVersion(protocolConfig.minVersion)}. Please upgrade your ecco SDK.`,
  };

  return {
    id: crypto.randomUUID(),
    from: fromPeerId,
    to: toPeerId,
    type: 'version-incompatible-notice',
    payload,
    timestamp: Date.now(),
  };
}

export function isHandshakeMessage(message: Message): boolean {
  return (
    message.type === 'version-handshake' ||
    message.type === 'version-handshake-response' ||
    message.type === 'version-incompatible-notice' ||
    message.type === 'constitution-mismatch-notice'
  );
}

export function parseHandshakePayload(payload: unknown): VersionHandshakePayload | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const p = payload as Record<string, unknown>;

  if (
    typeof p.protocolVersion !== 'object' ||
    p.protocolVersion === null ||
    typeof p.networkId !== 'string' ||
    typeof p.timestamp !== 'number'
  ) {
    return null;
  }

  const version = p.protocolVersion as Record<string, unknown>;
  if (
    typeof version.major !== 'number' ||
    typeof version.minor !== 'number' ||
    typeof version.patch !== 'number'
  ) {
    return null;
  }

  const constitutionHash = parseConstitutionHash(p.constitutionHash);
  if (!constitutionHash) {
    return null;
  }

  return {
    protocolVersion: {
      major: version.major,
      minor: version.minor,
      patch: version.patch,
    },
    networkId: p.networkId,
    timestamp: p.timestamp,
    constitutionHash,
  };
}

export function parseHandshakeResponse(payload: unknown): VersionHandshakeResponse | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const p = payload as Record<string, unknown>;

  if (
    typeof p.accepted !== 'boolean' ||
    typeof p.protocolVersion !== 'object' ||
    p.protocolVersion === null ||
    typeof p.minProtocolVersion !== 'object' ||
    p.minProtocolVersion === null
  ) {
    return null;
  }

  const version = p.protocolVersion as Record<string, unknown>;
  const minVersion = p.minProtocolVersion as Record<string, unknown>;

  if (
    typeof version.major !== 'number' ||
    typeof version.minor !== 'number' ||
    typeof version.patch !== 'number' ||
    typeof minVersion.major !== 'number' ||
    typeof minVersion.minor !== 'number' ||
    typeof minVersion.patch !== 'number'
  ) {
    return null;
  }

  return {
    accepted: p.accepted,
    protocolVersion: {
      major: version.major,
      minor: version.minor,
      patch: version.patch,
    },
    minProtocolVersion: {
      major: minVersion.major,
      minor: minVersion.minor,
      patch: minVersion.patch,
    },
    reason: typeof p.reason === 'string' ? p.reason : undefined,
    upgradeUrl: typeof p.upgradeUrl === 'string' ? p.upgradeUrl : undefined,
    constitutionMismatch: typeof p.constitutionMismatch === 'boolean' ? p.constitutionMismatch : undefined,
  };
}
