import { keccak256, toBytes } from 'viem';
import { z } from 'zod';
import { canonicalJsonStringify } from '../utils/canonical-json';
import { createProviderStorage, type StorageProviderConfig } from './provider-storage';

const RegistrationLocatorSchema = z.object({
  agentRegistry: z.string(),
  agentId: z.number().int().nonnegative(),
});

const RegistrationServiceSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().min(1),
  version: z.string().optional(),
}).catchall(z.unknown());

const RegistrationInputSchema = z.object({
  type: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  image: z.string().min(1),
  services: z.array(RegistrationServiceSchema).optional(),
  registrations: z.array(RegistrationLocatorSchema).optional(),
  supportedTrust: z.array(z.string()).optional(),
  x402Support: z.boolean().optional(),
  active: z.boolean().optional(),
}).catchall(z.unknown());

const RegistrationSchema = RegistrationInputSchema.extend({
  type: z.string().min(1),
});

const DEFAULT_REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export type AgentRegistrationInput = z.infer<typeof RegistrationInputSchema>;
export type AgentRegistration = z.infer<typeof RegistrationSchema>;
export type RegistrationLocator = z.infer<typeof RegistrationLocatorSchema>;

export interface RegistrationStorage {
  store(registration: AgentRegistration): Promise<string>;
  retrieve(uri: string): Promise<AgentRegistration | null>;
}

export function validateRegistration(registration: unknown): AgentRegistrationInput {
  return RegistrationInputSchema.parse(registration);
}

export function normalizeRegistration(
  registration: AgentRegistrationInput,
  locator: RegistrationLocator
): AgentRegistration {
  const baseType = registration.type ?? DEFAULT_REGISTRATION_TYPE;
  const registrations = registration.registrations ? [...registration.registrations] : [];
  const alreadyIncluded = registrations.some((entry) =>
    entry.agentId === locator.agentId && entry.agentRegistry === locator.agentRegistry
  );
  if (!alreadyIncluded) {
    registrations.push(locator);
  }

  return {
    ...registration,
    type: baseType,
    registrations,
  };
}

export function computeRegistrationHash(registration: AgentRegistration): `0x${string}` {
  const canonical = canonicalJsonStringify(registration);
  return keccak256(toBytes(canonical));
}

export function serializeRegistration(registration: AgentRegistration): string {
  return canonicalJsonStringify(registration);
}

export function deserializeRegistration(json: string): AgentRegistration {
  const parsed = JSON.parse(json);
  return RegistrationSchema.parse(parsed);
}

export function createProviderRegistrationStorage(config: StorageProviderConfig): RegistrationStorage {
  return createProviderStorage(config, serializeRegistration, deserializeRegistration);
}
