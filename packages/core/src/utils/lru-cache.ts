interface CacheNode<K, V> {
  key: K;
  value: V;
  prev: CacheNode<K, V> | null;
  next: CacheNode<K, V> | null;
}

export interface LRUCache<K, V> {
  readonly capacity: number;
  readonly size: number;
  get: (key: K) => V | undefined;
  set: (key: K, value: V) => void;
  delete: (key: K) => boolean;
  has: (key: K) => boolean;
  clear: () => void;
  keys: () => K[];
  values: () => V[];
  entries: () => [K, V][];
  toRecord: () => Record<string, V>;
  forEach: (callback: (value: V, key: K) => void) => void;
}

interface LRUCacheState<K, V> {
  capacity: number;
  map: Map<K, CacheNode<K, V>>;
  head: CacheNode<K, V> | null;
  tail: CacheNode<K, V> | null;
}

const createNode = <K, V>(key: K, value: V): CacheNode<K, V> => ({
  key,
  value,
  prev: null,
  next: null,
});

const removeNode = <K, V>(state: LRUCacheState<K, V>, node: CacheNode<K, V>): void => {
  if (node.prev) {
    node.prev.next = node.next;
  } else {
    state.head = node.next;
  }

  if (node.next) {
    node.next.prev = node.prev;
  } else {
    state.tail = node.prev;
  }
};

const addToFront = <K, V>(state: LRUCacheState<K, V>, node: CacheNode<K, V>): void => {
  node.next = state.head;
  node.prev = null;

  if (state.head) {
    state.head.prev = node;
  }

  state.head = node;

  if (!state.tail) {
    state.tail = node;
  }
};

const moveToFront = <K, V>(state: LRUCacheState<K, V>, node: CacheNode<K, V>): void => {
  removeNode(state, node);
  addToFront(state, node);
};

const evictLRU = <K, V>(state: LRUCacheState<K, V>): void => {
  if (!state.tail) return;

  const lruNode = state.tail;
  removeNode(state, lruNode);
  state.map.delete(lruNode.key);
};

export const createLRUCache = <K, V>(capacity: number): LRUCache<K, V> => {
  const effectiveCapacity = Math.max(1, Math.floor(capacity));
  if (effectiveCapacity !== capacity) {
    console.warn(`[lru-cache] Capacity adjusted from ${capacity} to ${effectiveCapacity}`);
  }
  const state: LRUCacheState<K, V> = {
    capacity: effectiveCapacity,
    map: new Map(),
    head: null,
    tail: null,
  };

  return {
    get capacity() {
      return state.capacity;
    },

    get size() {
      return state.map.size;
    },

    get(key: K): V | undefined {
      const node = state.map.get(key);
      if (!node) return undefined;

      moveToFront(state, node);
      return node.value;
    },

    set(key: K, value: V): void {
      const existingNode = state.map.get(key);

      if (existingNode) {
        existingNode.value = value;
        moveToFront(state, existingNode);
        return;
      }

      if (state.map.size >= state.capacity) {
        evictLRU(state);
      }

      const newNode = createNode(key, value);
      addToFront(state, newNode);
      state.map.set(key, newNode);
    },

    delete(key: K): boolean {
      const node = state.map.get(key);
      if (!node) return false;

      removeNode(state, node);
      state.map.delete(key);
      return true;
    },

    has(key: K): boolean {
      return state.map.has(key);
    },

    clear(): void {
      state.map.clear();
      state.head = null;
      state.tail = null;
    },

    keys(): K[] {
      const result: K[] = [];
      let current = state.head;
      while (current) {
        result.push(current.key);
        current = current.next;
      }
      return result;
    },

    values(): V[] {
      const result: V[] = [];
      let current = state.head;
      while (current) {
        result.push(current.value);
        current = current.next;
      }
      return result;
    },

    entries(): [K, V][] {
      const result: [K, V][] = [];
      let current = state.head;
      while (current) {
        result.push([current.key, current.value]);
        current = current.next;
      }
      return result;
    },

    toRecord(): Record<string, V> {
      const result: Record<string, V> = {};
      let current = state.head;
      while (current) {
        result[String(current.key)] = current.value;
        current = current.next;
      }
      return result;
    },

    forEach(callback: (value: V, key: K) => void): void {
      let current = state.head;
      while (current) {
        callback(current.value, current.key);
        current = current.next;
      }
    },
  };
};

export const cloneLRUCache = <K, V>(cache: LRUCache<K, V>): LRUCache<K, V> => {
  const newCache = createLRUCache<K, V>(cache.capacity);
  const entries = cache.entries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const [key, value] = entries[i];
    newCache.set(key, value);
  }
  return newCache;
};

export const fromRecord = <V>(record: Record<string, V>, capacity: number): LRUCache<string, V> => {
  const cache = createLRUCache<string, V>(capacity);
  const entries = Object.entries(record);
  const startIndex = Math.max(0, entries.length - capacity);
  for (let i = startIndex; i < entries.length; i++) {
    const [key, value] = entries[i];
    cache.set(key, value);
  }
  return cache;
};

