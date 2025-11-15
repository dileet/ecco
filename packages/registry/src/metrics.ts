import { Registry, Counter, Gauge, Histogram } from 'prom-client';

let registry: Registry | null = null;
let messagesTotal: Counter | null = null;
let connectionsTotal: Counter | null = null;
let registrationsTotal: Counter | null = null;
let queriesTotal: Counter | null = null;
let errorsTotal: Counter | null = null;
let activeConnections: Gauge | null = null;
let registeredNodes: Gauge | null = null;
let totalCapabilities: Gauge | null = null;
let messageProcessingDuration: Histogram | null = null;
let queryDuration: Histogram | null = null;

function initializeMetrics() {
  if (!registry) {
    registry = new Registry();

    messagesTotal = new Counter({
      name: 'ecco_registry_messages_total',
      help: 'Total number of messages processed',
      labelNames: ['type', 'status'],
      registers: [registry],
    });

    connectionsTotal = new Counter({
      name: 'ecco_registry_connections_total',
      help: 'Total number of connections',
      labelNames: ['status'],
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
      labelNames: ['status'],
      registers: [registry],
    });

    errorsTotal = new Counter({
      name: 'ecco_registry_errors_total',
      help: 'Total number of errors',
      labelNames: ['type'],
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
      labelNames: ['type'],
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

export function getMetrics(): string {
  initializeMetrics();
  return registry!.metrics();
}

export function getRegistry(): Registry {
  initializeMetrics();
  return registry!;
}

export function getMessagesTotal(): Counter {
  initializeMetrics();
  return messagesTotal!;
}

export function getConnectionsTotal(): Counter {
  initializeMetrics();
  return connectionsTotal!;
}

export function getRegistrationsTotal(): Counter {
  initializeMetrics();
  return registrationsTotal!;
}

export function getQueriesTotal(): Counter {
  initializeMetrics();
  return queriesTotal!;
}

export function getErrorsTotal(): Counter {
  initializeMetrics();
  return errorsTotal!;
}

export function getActiveConnections(): Gauge {
  initializeMetrics();
  return activeConnections!;
}

export function getRegisteredNodes(): Gauge {
  initializeMetrics();
  return registeredNodes!;
}

export function getTotalCapabilities(): Gauge {
  initializeMetrics();
  return totalCapabilities!;
}

export function getMessageProcessingDuration(): Histogram {
  initializeMetrics();
  return messageProcessingDuration!;
}

export function getQueryDuration(): Histogram {
  initializeMetrics();
  return queryDuration!;
}
