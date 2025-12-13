import {
  bleAdapter,
  delay,
  type TransportMessage,
} from '@ecco/core'

interface BLEPeripheral {
  id: string
  name?: string
  rssi: number
  advertisementData?: {
    localName?: string
    serviceUUIDs?: string[]
    manufacturerData?: Uint8Array
    serviceData?: Record<string, Uint8Array>
  }
}

interface BLEAdvertisingConfig {
  localName: string
  serviceUUIDs: string[]
  manufacturerData?: Uint8Array
}

interface BLENativeBridge {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  startScanning(serviceUUIDs: string[]): Promise<void>
  stopScanning(): Promise<void>
  startAdvertising(config: BLEAdvertisingConfig): Promise<void>
  stopAdvertising(): Promise<void>
  connect(peerId: string): Promise<void>
  disconnect(peerId: string): Promise<void>
  write(peerId: string, data: Uint8Array): Promise<void>
  read(peerId: string): Promise<Uint8Array>
  onPeripheralDiscovered(handler: (peripheral: BLEPeripheral) => void): () => void
  onPeripheralConnected(handler: (peerId: string) => void): () => void
  onPeripheralDisconnected(handler: (peerId: string) => void): () => void
  onDataReceived(handler: (peerId: string, data: Uint8Array) => void): () => void
}

const ECCO_SERVICE_UUID = '155b45d0-db4d-4587-9237-06089f2bf639'

interface MockDevice {
  id: string
  name: string
  advertisingConfig?: BLEAdvertisingConfig
  isAdvertising: boolean
  isScanning: boolean
  connectedPeers: Set<string>
  discoveryHandler?: (peripheral: BLEPeripheral) => void
  connectedHandler?: (peerId: string) => void
  disconnectedHandler?: (peerId: string) => void
  dataHandler?: (peerId: string, data: Uint8Array) => void
}

class MockBLERadio {
  private devices: Map<string, MockDevice> = new Map()

  registerDevice(id: string, name: string): void {
    this.devices.set(id, {
      id,
      name,
      isAdvertising: false,
      isScanning: false,
      connectedPeers: new Set(),
    })
    console.log(`[BLE Radio] Device registered: ${name} (${id.slice(0, 8)}...)`)
  }

  unregisterDevice(id: string): void {
    this.devices.delete(id)
  }

  startAdvertising(deviceId: string, config: BLEAdvertisingConfig): void {
    const device = this.devices.get(deviceId)
    if (device) {
      device.advertisingConfig = config
      device.isAdvertising = true
      console.log(`[BLE Radio] ${device.name} started advertising`)
      this.notifyScanners(deviceId)
    }
  }

  stopAdvertising(deviceId: string): void {
    const device = this.devices.get(deviceId)
    if (device) {
      device.isAdvertising = false
      console.log(`[BLE Radio] ${device.name} stopped advertising`)
    }
  }

  startScanning(deviceId: string, serviceUUIDs: string[]): void {
    const device = this.devices.get(deviceId)
    if (device) {
      device.isScanning = true
      console.log(`[BLE Radio] ${device.name} started scanning for services: ${serviceUUIDs.join(', ')}`)

      setTimeout(() => {
        for (const [otherId, otherDevice] of this.devices) {
          if (otherId !== deviceId && otherDevice.isAdvertising) {
            const hasMatchingService = otherDevice.advertisingConfig?.serviceUUIDs.some(
              uuid => serviceUUIDs.includes(uuid)
            )
            if (hasMatchingService && device.discoveryHandler) {
              const rssi = -40 - Math.floor(Math.random() * 30)
              device.discoveryHandler({
                id: otherId,
                name: otherDevice.name,
                rssi,
                advertisementData: {
                  localName: otherDevice.advertisingConfig?.localName,
                  serviceUUIDs: otherDevice.advertisingConfig?.serviceUUIDs,
                  manufacturerData: otherDevice.advertisingConfig?.manufacturerData,
                },
              })
            }
          }
        }
      }, 100)
    }
  }

  stopScanning(deviceId: string): void {
    const device = this.devices.get(deviceId)
    if (device) {
      device.isScanning = false
      console.log(`[BLE Radio] ${device.name} stopped scanning`)
    }
  }

  connect(fromId: string, toId: string): void {
    const fromDevice = this.devices.get(fromId)
    const toDevice = this.devices.get(toId)

    if (fromDevice && toDevice) {
      fromDevice.connectedPeers.add(toId)
      toDevice.connectedPeers.add(fromId)
      console.log(`[BLE Radio] ${fromDevice.name} connected to ${toDevice.name}`)

      if (fromDevice.connectedHandler) {
        fromDevice.connectedHandler(toId)
      }
      if (toDevice.connectedHandler) {
        toDevice.connectedHandler(fromId)
      }
    }
  }

  disconnect(fromId: string, toId: string): void {
    const fromDevice = this.devices.get(fromId)
    const toDevice = this.devices.get(toId)

    if (fromDevice && toDevice) {
      fromDevice.connectedPeers.delete(toId)
      toDevice.connectedPeers.delete(fromId)
      console.log(`[BLE Radio] ${fromDevice.name} disconnected from ${toDevice.name}`)

      if (fromDevice.disconnectedHandler) {
        fromDevice.disconnectedHandler(toId)
      }
      if (toDevice.disconnectedHandler) {
        toDevice.disconnectedHandler(fromId)
      }
    }
  }

  sendData(fromId: string, toId: string, data: Uint8Array): void {
    const fromDevice = this.devices.get(fromId)
    const toDevice = this.devices.get(toId)

    if (fromDevice && toDevice && fromDevice.connectedPeers.has(toId)) {
      console.log(`[BLE Radio] ${fromDevice.name} -> ${toDevice.name}: ${data.length} bytes`)
      if (toDevice.dataHandler) {
        toDevice.dataHandler(fromId, data)
      }
    }
  }

  setDiscoveryHandler(deviceId: string, handler: (peripheral: BLEPeripheral) => void): void {
    const device = this.devices.get(deviceId)
    if (device) {
      device.discoveryHandler = handler
    }
  }

  setConnectedHandler(deviceId: string, handler: (peerId: string) => void): void {
    const device = this.devices.get(deviceId)
    if (device) {
      device.connectedHandler = handler
    }
  }

  setDisconnectedHandler(deviceId: string, handler: (peerId: string) => void): void {
    const device = this.devices.get(deviceId)
    if (device) {
      device.disconnectedHandler = handler
    }
  }

  setDataHandler(deviceId: string, handler: (peerId: string, data: Uint8Array) => void): void {
    const device = this.devices.get(deviceId)
    if (device) {
      device.dataHandler = handler
    }
  }

  private notifyScanners(advertiserId: string): void {
    const advertiser = this.devices.get(advertiserId)
    if (!advertiser?.advertisingConfig) return

    for (const [scannerId, scanner] of this.devices) {
      if (scannerId !== advertiserId && scanner.isScanning && scanner.discoveryHandler) {
        const rssi = -40 - Math.floor(Math.random() * 30)
        scanner.discoveryHandler({
          id: advertiserId,
          name: advertiser.name,
          rssi,
          advertisementData: {
            localName: advertiser.advertisingConfig.localName,
            serviceUUIDs: advertiser.advertisingConfig.serviceUUIDs,
            manufacturerData: advertiser.advertisingConfig.manufacturerData,
          },
        })
      }
    }
  }
}

function createMockBLENativeBridge(
  deviceId: string,
  deviceName: string,
  radio: MockBLERadio
): BLENativeBridge {
  return {
    async initialize(): Promise<void> {
      radio.registerDevice(deviceId, deviceName)
    },

    async shutdown(): Promise<void> {
      radio.unregisterDevice(deviceId)
    },

    async startScanning(serviceUUIDs: string[]): Promise<void> {
      radio.startScanning(deviceId, serviceUUIDs)
    },

    async stopScanning(): Promise<void> {
      radio.stopScanning(deviceId)
    },

    async startAdvertising(config: BLEAdvertisingConfig): Promise<void> {
      radio.startAdvertising(deviceId, config)
    },

    async stopAdvertising(): Promise<void> {
      radio.stopAdvertising(deviceId)
    },

    async connect(peerId: string): Promise<void> {
      radio.connect(deviceId, peerId)
    },

    async disconnect(peerId: string): Promise<void> {
      radio.disconnect(deviceId, peerId)
    },

    async write(peerId: string, data: Uint8Array): Promise<void> {
      radio.sendData(deviceId, peerId, data)
    },

    async read(_peerId: string): Promise<Uint8Array> {
      return new Uint8Array()
    },

    onPeripheralDiscovered(handler: (peripheral: BLEPeripheral) => void): () => void {
      radio.setDiscoveryHandler(deviceId, handler)
      return () => radio.setDiscoveryHandler(deviceId, () => {})
    },

    onPeripheralConnected(handler: (peerId: string) => void): () => void {
      radio.setConnectedHandler(deviceId, handler)
      return () => radio.setConnectedHandler(deviceId, () => {})
    },

    onPeripheralDisconnected(handler: (peerId: string) => void): () => void {
      radio.setDisconnectedHandler(deviceId, handler)
      return () => radio.setDisconnectedHandler(deviceId, () => {})
    },

    onDataReceived(handler: (peerId: string, data: Uint8Array) => void): () => void {
      radio.setDataHandler(deviceId, handler)
      return () => radio.setDataHandler(deviceId, () => {})
    },
  }
}

const MENU: Record<string, Record<string, string>> = {
  Latte: { small: '0.003', large: '0.005' },
  Espresso: { single: '0.002', double: '0.003' },
  Cappuccino: { small: '0.0035', large: '0.0055' },
}

function decodeTransportMessage(message: TransportMessage): { type: string; payload: unknown } {
  const dataArray = message.data instanceof Uint8Array
    ? message.data
    : new Uint8Array(message.data as unknown as number[])
  const payloadJson = new TextDecoder().decode(dataArray)
  return JSON.parse(payloadJson) as { type: string; payload: unknown }
}

function encodeMessage(
  fromId: string,
  toId: string,
  type: string,
  payload: unknown
): TransportMessage {
  const payloadData = new TextEncoder().encode(JSON.stringify({ type, payload }))
  return {
    id: crypto.randomUUID(),
    from: fromId,
    to: toId,
    data: payloadData,
    timestamp: Date.now(),
  }
}

async function main(): Promise<void> {
  console.log('=== Bluetooth LE Transport Example ===\n')

  const radio = new MockBLERadio()

  const shopId = crypto.randomUUID()
  const customerId = crypto.randomUUID()

  console.log('--- Setting up Coffee Shop (BLE Peripheral) ---\n')

  const shopBridge = createMockBLENativeBridge(shopId, 'Starbucks-Downtown', radio)
  let shopAdapter = bleAdapter.createBLEAdapter({
    serviceUUID: ECCO_SERVICE_UUID,
    advertise: true,
    scan: false,
  })
  shopAdapter = bleAdapter.setBridge(shopAdapter, shopBridge)
  shopAdapter = bleAdapter.setLocalContext(shopAdapter, {
    locationId: 'starbucks-001',
    locationName: 'Starbucks Downtown',
    capabilities: ['coffee-shop', 'food-ordering'],
  })

  await bleAdapter.initialize(shopAdapter)
  console.log(`[Shop] Initialized with ID: ${shopId.slice(0, 12)}...`)

  shopBridge.onDataReceived((peerId, data) => {
    const json = new TextDecoder().decode(data)
    const parsed = JSON.parse(json) as TransportMessage
    for (const handler of shopAdapter.messageHandlers) {
      handler(peerId, parsed)
    }
  })

  bleAdapter.onMessage(shopAdapter, (peerId, message) => {
    const decoded = decodeTransportMessage(message)
    console.log(`[Shop] Received ${decoded.type} from ${peerId.slice(0, 8)}...`)

    if (decoded.type === 'menu-request') {
      const response = encodeMessage(shopId, peerId, 'menu-response', {
        shopName: 'Starbucks Downtown',
        items: Object.entries(MENU).map(([name, sizes]) => ({
          name,
          sizes: Object.fromEntries(
            Object.entries(sizes).map(([size, price]) => [size, `${price} ETH`])
          ),
        })),
      })
      bleAdapter.send(shopAdapter, peerId, response)
      console.log(`[Shop] Sent menu to ${peerId.slice(0, 8)}...`)
    }

    if (decoded.type === 'order-request') {
      const order = decoded.payload as { item: string; size: string }
      const price = MENU[order.item]?.[order.size]
      const orderId = crypto.randomUUID().slice(0, 8)

      const response = encodeMessage(shopId, peerId, 'order-response', {
        orderId,
        item: order.item,
        size: order.size,
        price: price ? `${price} ETH` : 'N/A',
        status: price ? 'confirmed' : 'error',
        message: price
          ? `Order #${orderId} confirmed! Your ${order.size} ${order.item} will be ready shortly.`
          : `Sorry, we don't have ${order.size} ${order.item}`,
      })
      bleAdapter.send(shopAdapter, peerId, response)
      console.log(`[Shop] Order ${orderId} ${price ? 'confirmed' : 'rejected'}`)
    }
  })

  await bleAdapter.startDiscovery(shopAdapter)

  console.log('\n--- Setting up Customer (BLE Central) ---\n')

  const customerBridge = createMockBLENativeBridge(customerId, 'Johns-iPhone', radio)
  let customerAdapter = bleAdapter.createBLEAdapter({
    serviceUUID: ECCO_SERVICE_UUID,
    advertise: false,
    scan: true,
  })
  customerAdapter = bleAdapter.setBridge(customerAdapter, customerBridge)

  await bleAdapter.initialize(customerAdapter)
  console.log(`[Customer] Initialized with ID: ${customerId.slice(0, 12)}...`)

  customerBridge.onDataReceived((peerId, data) => {
    const json = new TextDecoder().decode(data)
    const parsed = JSON.parse(json) as TransportMessage
    for (const handler of customerAdapter.messageHandlers) {
      handler(peerId, parsed)
    }
  })

  const discoveredShops: string[] = []

  bleAdapter.onDiscovery(customerAdapter, (event) => {
    if (event.type === 'discovered') {
      console.log(`[Customer] Discovered: ${event.peer.metadata?.name || event.peer.id.slice(0, 8)} (RSSI: ${event.peer.rssi})`)
      discoveredShops.push(event.peer.id)
    }
  })

  const responsePromises: Map<string, { resolve: (value: unknown) => void }> = new Map()

  bleAdapter.onMessage(customerAdapter, (_peerId, message) => {
    const decoded = decodeTransportMessage(message)
    console.log(`[Customer] Received ${decoded.type}`)

    const waiting = responsePromises.get(decoded.type)
    if (waiting) {
      waiting.resolve(decoded.payload)
      responsePromises.delete(decoded.type)
    }
  })

  console.log('\n--- Scanning for Nearby Coffee Shops ---\n')

  await bleAdapter.startDiscovery(customerAdapter)
  await delay(500)

  if (discoveredShops.length === 0) {
    console.log('[Customer] No coffee shops found nearby')
    await bleAdapter.shutdown(shopAdapter)
    await bleAdapter.shutdown(customerAdapter)
    return
  }

  const targetShop = discoveredShops[0]
  console.log(`\n[Customer] Connecting to shop ${targetShop.slice(0, 8)}...`)
  await bleAdapter.connect(customerAdapter, targetShop)

  await delay(200)

  console.log('\n--- Requesting Menu ---\n')

  const menuPromise = new Promise((resolve) => {
    responsePromises.set('menu-response', { resolve })
  })

  const menuRequest = encodeMessage(customerId, targetShop, 'menu-request', {})
  await bleAdapter.send(customerAdapter, targetShop, menuRequest)

  const menuResponse = await Promise.race([
    menuPromise,
    delay(5000).then(() => null),
  ]) as { shopName: string; items: Array<{ name: string; sizes: Record<string, string> }> } | null

  if (menuResponse) {
    console.log(`\n[Customer] Menu from ${menuResponse.shopName}:`)
    for (const item of menuResponse.items) {
      console.log(`  - ${item.name}: ${Object.entries(item.sizes).map(([s, p]) => `${s} ${p}`).join(', ')}`)
    }
  }

  console.log('\n--- Placing Order ---\n')

  const orderPromise = new Promise((resolve) => {
    responsePromises.set('order-response', { resolve })
  })

  const orderRequest = encodeMessage(customerId, targetShop, 'order-request', {
    item: 'Latte',
    size: 'large',
  })
  await bleAdapter.send(customerAdapter, targetShop, orderRequest)

  const orderResponse = await Promise.race([
    orderPromise,
    delay(5000).then(() => null),
  ]) as { orderId: string; message: string; price: string } | null

  if (orderResponse) {
    console.log(`[Customer] ${orderResponse.message}`)
    console.log(`[Customer] Price: ${orderResponse.price}`)
  }

  console.log('\n--- Disconnecting ---\n')

  await bleAdapter.disconnect(customerAdapter, targetShop)
  await delay(200)

  console.log('\n--- Shutting Down ---\n')

  await bleAdapter.shutdown(customerAdapter)
  await bleAdapter.shutdown(shopAdapter)
  console.log('Example complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
