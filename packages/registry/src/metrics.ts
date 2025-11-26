import { Registry, Counter, Gauge, Histogram } from 'prom-client';

let registry: Registry | null = null;
let messagesTotal: Counter<'type' | 'status'> | null = null;
let connectionsTotal: Counter<'status'> | null = null;
let registrationsTotal: Counter<string> | null = null;
let queriesTotal: Counter<'status'> | null = null;
let errorsTotal: Counter<'type'> | null = null;
let activeConnections: Gauge<string> | null = null;
let registeredNodes: Gauge<string> | null = null;
let totalCapabilities: Gauge<string> | null = null;
let messageProcessingDuration: Histogram<'type'> | null = null;
let queryDuration: Histogram<string> | null = null;

function initializeMetrics() {
  if (!registry) {
    registry = new Registry();

    messagesTotal = new Counter({
      name: 'ecco_registry_messages_total',
      help: 'Total number of messages processed',
      labelNames: ['type', 'status'] as const,
      registers: [registry],
    });

    connectionsTotal = new Counter({
      name: 'ecco_registry_connections_total',
      help: 'Total number of connections',
      labelNames: ['status'] as const,
      registers: [registry],
    });

    registrationsTotal = new Counter({
      name: 'ecco_registry_registrations_total',
      help: 'Total number of node registrations',
      registers: [registry],
    });

    queriesTotal = new Counter({
      name: 'ecco_registry_queries_total',
      help: 'Total number of capability queries',
      labelNames: ['status'] as const,
      registers: [registry],
    });

    errorsTotal = new Counter({
      name: 'ecco_registry_errors_total',
      help: 'Total number of errors',
      labelNames: ['type'] as const,
      registers: [registry],
    });

    activeConnections = new Gauge({
      name: 'ecco_registry_active_connections',
      help: 'Number of active connections',
      registers: [registry],
    });

    registeredNodes = new Gauge({
      name: 'ecco_registry_registered_nodes',
      help: 'Number of registered nodes',
      registers: [registry],
    });

    totalCapabilities = new Gauge({
      name: 'ecco_registry_total_capabilities',
      help: 'Total number of capabilities across all nodes',
      registers: [registry],
    });

    messageProcessingDuration = new Histogram({
      name: 'ecco_registry_message_processing_duration_seconds',
      help: 'Message processing duration in seconds',
      labelNames: ['type'] as const,
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [registry],
    });

    queryDuration = new Histogram({
      name: 'ecco_registry_query_duration_seconds',
      help: 'Query duration in seconds',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [registry],
    });
  }
}

export async function getMetrics(): Promise<string> {
  initializeMetrics();
  return registry!.metrics();
}

export function getRegistry(): Registry {
  initializeMetrics();
  return registry!;
}

export function getMessagesTotal(): Counter<'type' | 'status'> {
  initializeMetrics();
  return messagesTotal!;
}

export function getConnectionsTotal(): Counter<'status'> {
  initializeMetrics();
  return connectionsTotal!;
}

export function getRegistrationsTotal(): Counter<string> {
  initializeMetrics();
  return registrationsTotal!;
}

export function getQueriesTotal(): Counter<'status'> {
  initializeMetrics();
  return queriesTotal!;
}

export function getErrorsTotal(): Counter<'type'> {
  initializeMetrics();
  return errorsTotal!;
}

export function getActiveConnections(): Gauge<string> {
  initializeMetrics();
  return activeConnections!;
}

export function getRegisteredNodes(): Gauge<string> {
  initializeMetrics();
  return registeredNodes!;
}

export function getTotalCapabilities(): Gauge<string> {
  initializeMetrics();
  return totalCapabilities!;
}

export function getMessageProcessingDuration(): Histogram<'type'> {
  initializeMetrics();
  return messageProcessingDuration!;
}

export function getQueryDuration(): Histogram<string> {
  initializeMetrics();
  return queryDuration!;
}
