import { nanoid } from 'nanoid';
import { Matcher } from '../capability-matcher';
import { Pool } from '../connection';
import { Config } from '../config';
import type { EccoConfig } from '../types';
import type { NodeState } from './types';

export function createNodeState(config: EccoConfig): NodeState {
  const fullConfig = Config.merge(Config.defaults, config);

  const state: NodeState = {
    id: fullConfig.nodeId || nanoid(),
    config: fullConfig,
    node: null,
    capabilities: fullConfig.capabilities || [],
    peers: new Map(),
    subscriptions: new Map(),
    capabilityMatcher: Matcher.create(),
    circuitBreakers: new Map(),
    capabilityTrackingSetup: false,
    ...(fullConfig.connectionPool ? { connectionPool: Pool.createState(fullConfig.connectionPool) } : {}),
  };

  return state;
}
