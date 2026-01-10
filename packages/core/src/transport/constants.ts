export const MANAGER = {
  MIN_RSSI: -100,
  MAX_RSSI: 0,
} as const

export const HYBRID_DISCOVERY = {
  MAX_DISCOVERED_PEERS: 1000,
} as const

export const MESSAGE_BRIDGE = {
  MAX_QUEUED_MESSAGES_PER_PEER: 100,
  QUEUED_MESSAGE_DEDUP_FALSE_POSITIVE_RATE: 0.01,
  MAX_MESSAGE_SIZE_BYTES: 10 * 1024 * 1024,
} as const

export const BLUETOOTH_LE = {
  SERVICE_UUID: '155b45d0-db4d-4587-9237-06089f2bf639',
  CHAR_UUID: '2f436cd1-a421-48a7-bc84-43949ed40fa5',
} as const

export const LIBP2P = {
  TRANSPORT_TOPIC: 'ecco/transport/v1',
  MAX_MESSAGE_SIZE: 10 * 1024 * 1024,
} as const
