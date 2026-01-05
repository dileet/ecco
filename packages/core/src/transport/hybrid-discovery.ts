import type {
  TransportType,
  TransportAdapter,
  TransportPeer,
  TransportMessage,
  TransportDiscoveryEvent,
  TransportConnectionEvent,
} from './types';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_DISCOVERED_PEERS = 1000;

export type DiscoveryPhase = 'proximity' | 'local' | 'internet' | 'fallback';

export interface HybridDiscoveryConfig {
  phases: DiscoveryPhase[];
  phaseTimeout: number;
  autoEscalate: boolean;
  preferProximity: boolean;
  connectionRetries: number;
  retryDelay: number;
  peerTtlMs: number;
}

export interface DiscoveryResult {
  peer: TransportPeer;
  phase: DiscoveryPhase;
  transport: TransportType;
  latency?: number;
}

export interface HybridDiscoveryState {
  config: HybridDiscoveryConfig;
  adapters: Map<TransportType, TransportAdapter>;
  phaseMapping: Map<DiscoveryPhase, TransportType[]>;
  discoveredPeers: Map<string, DiscoveryResult>;
  currentPhase: DiscoveryPhase;
  isDiscovering: boolean;
  handlers: {
    discovery: Set<(result: DiscoveryResult) => void>;
    connection: Set<(event: TransportConnectionEvent) => void>;
    message: Set<(peerId: string, message: TransportMessage) => void>;
    phaseChange: Set<(phase: DiscoveryPhase) => void>;
  };
  adapterCleanups: Map<TransportType, Array<() => void>>;
  escalationTimers: Array<ReturnType<typeof setTimeout>>;
}

const DEFAULT_CONFIG: HybridDiscoveryConfig = {
  phases: ['proximity', 'local', 'internet', 'fallback'],
  phaseTimeout: 5000,
  autoEscalate: true,
  preferProximity: true,
  connectionRetries: 3,
  retryDelay: 1000,
  peerTtlMs: 5000,
};

const DEFAULT_PHASE_MAPPING = new Map<DiscoveryPhase, TransportType[]>([
  ['proximity', ['bluetooth-le']],
  ['local', ['libp2p']],
  ['internet', ['libp2p']],
  ['fallback', ['libp2p']],
]);

export function createHybridDiscovery(
  config: Partial<HybridDiscoveryConfig> = {}
): HybridDiscoveryState {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const peerTtlMs = config.peerTtlMs ?? mergedConfig.phaseTimeout;
  return {
    config: { ...mergedConfig, peerTtlMs },
    adapters: new Map(),
    phaseMapping: new Map(DEFAULT_PHASE_MAPPING),
    discoveredPeers: new Map(),
    currentPhase: config.phases?.[0] ?? 'proximity',
    isDiscovering: false,
    handlers: {
      discovery: new Set(),
      connection: new Set(),
      message: new Set(),
      phaseChange: new Set(),
    },
    adapterCleanups: new Map(),
    escalationTimers: [],
  };
}

export function registerAdapter(
  state: HybridDiscoveryState,
  adapter: TransportAdapter
): HybridDiscoveryState {
  const adapters = new Map(state.adapters);
  adapters.set(adapter.type, adapter);
  return { ...state, adapters };
}

export function unregisterAdapter(
  state: HybridDiscoveryState,
  adapterType: TransportType
): HybridDiscoveryState {
  const cleanups = state.adapterCleanups.get(adapterType);
  if (cleanups) {
    for (const cleanup of cleanups) {
      cleanup();
    }
  }

  const adapters = new Map(state.adapters);
  adapters.delete(adapterType);

  const adapterCleanups = new Map(state.adapterCleanups);
  adapterCleanups.delete(adapterType);

  const discoveredPeers = new Map(state.discoveredPeers);
  for (const [peerId, result] of discoveredPeers) {
    if (result.transport === adapterType) {
      discoveredPeers.delete(peerId);
    }
  }

  return { ...state, adapters, adapterCleanups, discoveredPeers };
}

export function setPhaseMapping(
  state: HybridDiscoveryState,
  phase: DiscoveryPhase,
  transports: TransportType[]
): HybridDiscoveryState {
  const phaseMapping = new Map(state.phaseMapping);
  phaseMapping.set(phase, transports);
  return { ...state, phaseMapping };
}

export async function startDiscovery(
  state: HybridDiscoveryState
): Promise<HybridDiscoveryState> {
  if (state.isDiscovering) return state;

  const adapterCleanups = new Map(state.adapterCleanups);

  for (const adapter of state.adapters.values()) {
    const cleanups: Array<() => void> = [];

    const discoveryCleanup = adapter.onDiscovery((event) => {
      handleAdapterDiscovery(state, adapter.type, event);
    });
    cleanups.push(discoveryCleanup);

    const connectionCleanup = adapter.onConnection((event) => {
      for (const handler of state.handlers.connection) {
        handler(event);
      }
    });
    cleanups.push(connectionCleanup);

    const messageCleanup = adapter.onMessage((peerId, message) => {
      for (const handler of state.handlers.message) {
        handler(peerId, message);
      }
    });
    cleanups.push(messageCleanup);

    const existingCleanups = adapterCleanups.get(adapter.type) ?? [];
    adapterCleanups.set(adapter.type, [...existingCleanups, ...cleanups]);
  }

  await startPhase(state, state.currentPhase);

  if (state.config.autoEscalate) {
    schedulePhaseEscalation(state);
  }

  return {
    ...state,
    isDiscovering: true,
    adapterCleanups,
  };
}

async function startPhase(
  state: HybridDiscoveryState,
  phase: DiscoveryPhase
): Promise<void> {
  state.currentPhase = phase;

  for (const handler of state.handlers.phaseChange) {
    handler(phase);
  }

  const transports = state.phaseMapping.get(phase) ?? [];
  const availableTransports = transports.filter((t) => state.adapters.has(t));

  const startPromises = availableTransports.map(async (transport) => {
    const adapter = state.adapters.get(transport);
    if (adapter && adapter.state === 'connected') {
      await adapter.startDiscovery();
    }
  });

  await Promise.all(startPromises);
}

function clearEscalationTimers(state: HybridDiscoveryState): void {
  for (const timerId of state.escalationTimers) {
    clearTimeout(timerId);
  }
  state.escalationTimers.length = 0;
}

function schedulePhaseEscalation(state: HybridDiscoveryState): void {
  const { phases, phaseTimeout } = state.config;
  const currentIndex = phases.indexOf(state.currentPhase);

  clearEscalationTimers(state);

  if (currentIndex < phases.length - 1) {
    const timerId = setTimeout(() => {
      if (!state.isDiscovering) {
        return;
      }

      const hasFreshPeers = hasRecentPeers(state, Date.now());

      if (!hasFreshPeers) {
        const nextPhase = phases[currentIndex + 1];
        startPhase(state, nextPhase);
        schedulePhaseEscalation(state);
      }
    }, phaseTimeout);
    state.escalationTimers.push(timerId);
  }
}

function hasRecentPeers(state: HybridDiscoveryState, now: number): boolean {
  const cutoff = now - state.config.peerTtlMs;
  for (const result of state.discoveredPeers.values()) {
    if (result.peer.lastSeen >= cutoff) {
      return true;
    }
  }
  return false;
}

function evictOldestPeer(discoveredPeers: Map<string, DiscoveryResult>): void {
  let oldestPeerId: string | null = null;
  let oldestLastSeen = Infinity;

  for (const [peerId, result] of discoveredPeers) {
    const lastSeen = result.peer.lastSeen ?? 0;
    if (lastSeen < oldestLastSeen) {
      oldestLastSeen = lastSeen;
      oldestPeerId = peerId;
    }
  }

  if (oldestPeerId) {
    discoveredPeers.delete(oldestPeerId);
  }
}

function handleAdapterDiscovery(
  state: HybridDiscoveryState,
  transport: TransportType,
  event: TransportDiscoveryEvent
): void {
  const phase = getPhaseForTransport(state, transport);

  if (event.type === 'discovered' || event.type === 'updated') {
    const isUpdate = state.discoveredPeers.has(event.peer.id);

    if (!isUpdate && state.discoveredPeers.size >= MAX_DISCOVERED_PEERS) {
      evictOldestPeer(state.discoveredPeers);
    }

    const result: DiscoveryResult = {
      peer: event.peer,
      phase,
      transport,
    };

    state.discoveredPeers.set(event.peer.id, result);

    if (!isUpdate) {
      clearEscalationTimers(state);
    }

    for (const handler of state.handlers.discovery) {
      handler(result);
    }
  } else if (event.type === 'lost') {
    state.discoveredPeers.delete(event.peer.id);
  }
}

function getPhaseForTransport(
  state: HybridDiscoveryState,
  transport: TransportType
): DiscoveryPhase {
  for (const [phase, transports] of state.phaseMapping) {
    if (transports.includes(transport)) {
      return phase;
    }
  }
  return 'fallback';
}

export async function stopDiscovery(
  state: HybridDiscoveryState
): Promise<HybridDiscoveryState> {
  clearEscalationTimers(state);

  for (const cleanups of state.adapterCleanups.values()) {
    for (const cleanup of cleanups) {
      cleanup();
    }
  }

  const stopPromises = Array.from(state.adapters.values()).map(
    async (adapter) => {
      await adapter.stopDiscovery();
    }
  );

  await Promise.all(stopPromises);

  return {
    ...state,
    isDiscovering: false,
    adapterCleanups: new Map(),
    escalationTimers: [],
  };
}

export async function connectWithFallback(
  state: HybridDiscoveryState,
  peerId: string
): Promise<{ success: boolean; transport?: TransportType; error?: Error }> {
  const result = state.discoveredPeers.get(peerId);
  if (!result) {
    return { success: false, error: new Error('Peer not discovered') };
  }

  const transportPriority = getTransportPriority(state, result);

  for (const transport of transportPriority) {
    const adapter = state.adapters.get(transport);
    if (!adapter || adapter.state !== 'connected') continue;

    for (let attempt = 0; attempt < state.config.connectionRetries; attempt++) {
      try {
        await adapter.connect(peerId);
        return { success: true, transport };
      } catch (error) {
        if (attempt < state.config.connectionRetries - 1) {
          await delay(state.config.retryDelay);
        }
      }
    }
  }

  return { success: false, error: new Error('All connection attempts failed') };
}

function getTransportPriority(
  state: HybridDiscoveryState,
  result: DiscoveryResult
): TransportType[] {
  const priority: TransportType[] = [];

  if (state.config.preferProximity && isProximityTransport(result.transport)) {
    priority.push(result.transport);
  }

  priority.push(result.transport);

  const phaseTransports = state.phaseMapping.get(result.phase) ?? [];
  for (const t of phaseTransports) {
    if (!priority.includes(t) && state.adapters.has(t)) {
      priority.push(t);
    }
  }

  for (const t of state.adapters.keys()) {
    if (!priority.includes(t)) {
      priority.push(t);
    }
  }

  return priority;
}

function isProximityTransport(transport: TransportType): boolean {
  return transport === 'bluetooth-le';
}

export async function sendWithFallback(
  state: HybridDiscoveryState,
  peerId: string,
  message: TransportMessage
): Promise<{ success: boolean; transport?: TransportType; error?: Error }> {
  const result = state.discoveredPeers.get(peerId);
  const transportPriority = result
    ? getTransportPriority(state, result)
    : Array.from(state.adapters.keys());

  let lastError: Error | undefined;

  for (const transport of transportPriority) {
    const adapter = state.adapters.get(transport);
    if (!adapter || adapter.state !== 'connected') continue;

    try {
      await adapter.send(peerId, message);
      return { success: true, transport };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  return { success: false, error: lastError ?? new Error('No connected transport for peer') };
}

export function getDiscoveredPeers(state: HybridDiscoveryState): DiscoveryResult[] {
  return Array.from(state.discoveredPeers.values());
}

export function getProximityPeers(state: HybridDiscoveryState): DiscoveryResult[] {
  return Array.from(state.discoveredPeers.values()).filter((r) =>
    isProximityTransport(r.transport)
  );
}

export function getPeersByPhase(
  state: HybridDiscoveryState,
  phase: DiscoveryPhase
): DiscoveryResult[] {
  return Array.from(state.discoveredPeers.values()).filter(
    (r) => r.phase === phase
  );
}

export function onDiscovery(
  state: HybridDiscoveryState,
  handler: (result: DiscoveryResult) => void
): () => void {
  state.handlers.discovery.add(handler);
  return () => state.handlers.discovery.delete(handler);
}

export function onConnection(
  state: HybridDiscoveryState,
  handler: (event: TransportConnectionEvent) => void
): () => void {
  state.handlers.connection.add(handler);
  return () => state.handlers.connection.delete(handler);
}

export function onMessage(
  state: HybridDiscoveryState,
  handler: (peerId: string, message: TransportMessage) => void
): () => void {
  state.handlers.message.add(handler);
  return () => state.handlers.message.delete(handler);
}

export function onPhaseChange(
  state: HybridDiscoveryState,
  handler: (phase: DiscoveryPhase) => void
): () => void {
  state.handlers.phaseChange.add(handler);
  return () => state.handlers.phaseChange.delete(handler);
}

export function getCurrentPhase(state: HybridDiscoveryState): DiscoveryPhase {
  return state.currentPhase;
}

export function forcePhase(
  state: HybridDiscoveryState,
  phase: DiscoveryPhase
): HybridDiscoveryState {
  clearEscalationTimers(state);
  startPhase(state, phase);
  if (state.config.autoEscalate && state.isDiscovering) {
    schedulePhaseEscalation(state);
  }
  return { ...state, currentPhase: phase };
}

export function getTransportStats(state: HybridDiscoveryState): {
  phase: DiscoveryPhase;
  adaptersActive: number;
  peersByTransport: Record<string, number>;
  peersByPhase: Record<string, number>;
} {
  const peersByTransport: Record<string, number> = {};
  const peersByPhase: Record<string, number> = {};

  for (const result of state.discoveredPeers.values()) {
    peersByTransport[result.transport] = (peersByTransport[result.transport] ?? 0) + 1;
    peersByPhase[result.phase] = (peersByPhase[result.phase] ?? 0) + 1;
  }

  return {
    phase: state.currentPhase,
    adaptersActive: Array.from(state.adapters.values()).filter(
      (a) => a.state === 'connected'
    ).length,
    peersByTransport,
    peersByPhase,
  };
}
