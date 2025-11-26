import {
  createHybridDiscovery,
  registerTransportAdapter,
  startTransportDiscovery,
  connectWithFallback,
  getTransportProximityPeers,
  getPeersByPhase,
  onTransportDiscovery,
  onPhaseChange,
  getTransportStats,
  bleAdapter,
  webrtcTransport,
  type HybridDiscoveryState,
  type LocalContext,
  type DiscoveryResult,
} from '@ecco/core';

const COFFEE_SHOP_CONTEXT: LocalContext = {
  locationId: 'brew-lab-sf-001',
  locationName: 'Brew Lab Coffee',
  capabilities: [
    'menu-query',
    'order-placement',
    'loyalty-rewards',
    'local-recommendations',
    'wifi-password',
  ],
  metadata: {
    type: 'retail',
    category: 'coffee-shop',
    hours: '7am-7pm',
    address: '123 Valencia St, SF',
  },
};

async function runCoffeeShopNode(): Promise<void> {
  console.log('☕ Starting Coffee Shop Node...\n');

  const bleState = bleAdapter.createBLEAdapter({
    advertise: true,
    scan: false,
  });

  bleAdapter.setLocalContext(bleState, COFFEE_SHOP_CONTEXT);

  let discovery = createHybridDiscovery({
    phases: ['proximity', 'local'],
    autoEscalate: false,
    preferProximity: true,
  });

  discovery = registerTransportAdapter(discovery, bleAdapter.toAdapter(bleState));
  await startTransportDiscovery(discovery);

  console.log('📡 Coffee shop beacon active');
  console.log(`   Location: ${COFFEE_SHOP_CONTEXT.locationName}`);
  console.log(`   Capabilities: ${COFFEE_SHOP_CONTEXT.capabilities.join(', ')}`);
}

async function runMobileNode(): Promise<void> {
  console.log('📱 Starting Mobile Node with Hybrid Discovery...\n');

  const bleState = bleAdapter.createBLEAdapter({
    advertise: false,
    scan: true,
    scanInterval: 2000,
  });

  const webrtcState = webrtcTransport.createWebRTCAdapter('mobile-node-001', {
    signalingServer: 'wss://signal.ecco.network',
  });

  let discovery = createHybridDiscovery({
    phases: ['proximity', 'local', 'internet', 'fallback'],
    phaseTimeout: 5000,
    autoEscalate: true,
    preferProximity: true,
    connectionRetries: 3,
  });

  discovery = registerTransportAdapter(discovery, bleAdapter.toAdapter(bleState));
  discovery = registerTransportAdapter(discovery, webrtcTransport.toAdapter(webrtcState));

  onPhaseChange(discovery, (phase) => {
    console.log(`\n📶 Discovery phase changed to: ${phase.toUpperCase()}`);
    const stats = getTransportStats(discovery);
    console.log(`   Active adapters: ${stats.adaptersActive}`);
  });

  onTransportDiscovery(discovery, (result) => {
    handleDiscovery(result);
  });

  await startTransportDiscovery(discovery);

  console.log('🔍 Starting hybrid discovery...');
  console.log('   Phase order: BLE → Local → Internet → Fallback\n');

  pollAndDisplayStats(discovery);
}

function handleDiscovery(result: DiscoveryResult): void {
  const context = result.peer.metadata?.localContext as LocalContext | undefined;
  
  console.log(`\n🎯 Discovered peer via ${result.transport}:`);
  console.log(`   ID: ${result.peer.id}`);
  console.log(`   Phase: ${result.phase}`);
  
  if (context?.locationName) {
    console.log(`   📍 Location: ${context.locationName}`);
  }
  
  if (result.peer.rssi) {
    const distance = rssiToDistance(result.peer.rssi);
    console.log(`   📡 Signal: ${result.peer.rssi} dBm (${distance})`);
  }
  
  if (context?.capabilities) {
    console.log(`   🔧 Services: ${context.capabilities.join(', ')}`);
  }
}

function rssiToDistance(rssi: number): string {
  if (rssi >= -50) return 'immediate (~1m)';
  if (rssi >= -70) return 'near (~5m)';
  if (rssi >= -90) return 'far (~10m+)';
  return 'unknown';
}

function pollAndDisplayStats(discovery: HybridDiscoveryState): void {
  setInterval(() => {
    const stats = getTransportStats(discovery);
    const proximityPeers = getTransportProximityPeers(discovery);
    const internetPeers = getPeersByPhase(discovery, 'internet');

    console.log('\n--- Discovery Stats ---');
    console.log(`Current Phase: ${stats.phase}`);
    console.log(`Proximity peers: ${proximityPeers.length}`);
    console.log(`Internet peers: ${internetPeers.length}`);
    console.log(`Peers by transport:`, stats.peersByTransport);
    console.log('------------------------');
  }, 10000);
}

async function connectToNearbyShop(discovery: HybridDiscoveryState): Promise<void> {
  const proximityPeers = getTransportProximityPeers(discovery);

  const coffeeShop = proximityPeers.find((result) => {
    const context = result.peer.metadata?.localContext as LocalContext | undefined;
    return context?.metadata?.category === 'coffee-shop';
  });

  if (!coffeeShop) {
    console.log('No coffee shops nearby');
    return;
  }

  console.log(`\n☕ Connecting to ${coffeeShop.peer.id}...`);
  
  const result = await connectWithFallback(discovery, coffeeShop.peer.id);
  
  if (result.success) {
    console.log(`✅ Connected via ${result.transport}!`);
  } else {
    console.log(`❌ Connection failed: ${result.error?.message}`);
  }
}

const mode = process.argv[2] ?? 'mobile';

if (mode === 'shop') {
  runCoffeeShopNode();
} else {
  runMobileNode();
}

