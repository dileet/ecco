import { nanoid } from 'nanoid';
import { Pool } from '../connection';
import { configDefaults, mergeConfig } from '../config';
import type { EccoConfig } from '../types';
import type { NodeState } from './types';

export function createNodeState(config: EccoConfig): NodeState {
  const fullConfig = mergeConfig(configDefaults, config);

  const state: NodeState = {
    id: fullConfig.nodeId || nanoid(),
    config: fullConfig,
    node: null,
    capabilities: fullConfig.capabilities || [],
    peers: new Map(),
    subscriptions: new Map(),
    capabilityTrackingSetup: false,
    paymentLedger: new Map(),
    streamingChannels: new Map(),
    escrowAgreements: new Map(),
    stakePositions: new Map(),
    swarmSplits: new Map(),
    pendingSettlements: [],
    ...(fullConfig.connectionPool ? { connectionPool: Pool.createState(fullConfig.connectionPool) } : {}),
  };

  return state;
}
