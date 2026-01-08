import { z } from 'zod';
import type {
  Message,
  ProtocolVersion,
  ProtocolConfig,
  VersionHandshakePayload,
  VersionHandshakeResponse,
  VersionIncompatibleNotice,
  ConstitutionHash,
  Constitution,
} from '../types';
import type { NetworkConfig } from '../networks';
import { isCompatible, formatVersion } from './version';
import { computeConstitutionHash, validateConstitution, parseConstitutionHash } from './constitution';
import { fetchOnChainConstitution } from './on-chain-constitution';

const ProtocolVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
});

const HandshakePayloadSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  networkId: z.string(),
  timestamp: z.number(),
  constitutionHash: z.string(),
});

const HandshakeResponseSchema = z.object({
  accepted: z.boolean(),
  protocolVersion: ProtocolVersionSchema,
  minProtocolVersion: ProtocolVersionSchema,
  reason: z.string().optional(),
  upgradeUrl: z.string().optional(),
  constitutionMismatch: z.boolean().optional(),
});

export const HANDSHAKE_TIMEOUT_MS = 5000;
export const DISCONNECT_DELAY_MS = 1000;

async function getEffectiveConstitution(networkConfig: NetworkConfig): Promise<Constitution> {
  const onChainConfig = networkConfig.onChainConstitution;
  if (onChainConfig?.enabled) {
    try {
      return await fetchOnChainConstitution(onChainConfig.chainId, onChainConfig.rpcUrl);
    } catch {
      return networkConfig.constitution;
    }
  }
  return networkConfig.constitution;
}

export async function createHandshakeMessage(
  fromPeerId: string,
  toPeerId: string,
  networkConfig: NetworkConfig
): Promise<Message> {
  const constitution = await getEffectiveConstitution(networkConfig);
  const constitutionHash = await computeConstitutionHash(constitution);

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
  requestId: string,
  peerNetworkId?: string
): Promise<Message> {
  const protocolConfig = networkConfig.protocol;
  const compatibility = isCompatible(peerVersion, protocolConfig.minVersion);

  const constitution = await getEffectiveConstitution(networkConfig);
  const localConstitutionHash = await computeConstitutionHash(constitution);
  const constitutionValidation = validateConstitution(localConstitutionHash, peerConstitutionHash);

  const versionAccepted = compatibility.compatible || protocolConfig.enforcementLevel === 'none';
  const constitutionAccepted = constitutionValidation.valid;
  const networkIdMatches = !peerNetworkId || peerNetworkId === networkConfig.networkId;
  const accepted = versionAccepted && constitutionAccepted && networkIdMatches;

  let reason = compatibility.reason;
  if (!constitutionAccepted) {
    reason = constitutionValidation.reason;
  }
  if (!networkIdMatches) {
    reason = `Network ID mismatch: expected ${networkConfig.networkId}, got ${peerNetworkId}`;
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
  const result = HandshakePayloadSchema.safeParse(payload);
  if (!result.success) {
    return null;
  }

  const constitutionHash = parseConstitutionHash(result.data.constitutionHash);
  if (!constitutionHash) {
    return null;
  }

  return {
    protocolVersion: result.data.protocolVersion,
    networkId: result.data.networkId,
    timestamp: result.data.timestamp,
    constitutionHash,
  };
}

export function parseHandshakeResponse(payload: unknown): VersionHandshakeResponse | null {
  const result = HandshakeResponseSchema.safeParse(payload);
  if (!result.success) {
    return null;
  }

  return {
    accepted: result.data.accepted,
    protocolVersion: result.data.protocolVersion,
    minProtocolVersion: result.data.minProtocolVersion,
    reason: result.data.reason,
    upgradeUrl: result.data.upgradeUrl,
    constitutionMismatch: result.data.constitutionMismatch,
  };
}
