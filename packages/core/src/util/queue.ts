export interface QueueConfig {
  concurrency: number;
  timeout?: number;
}

export interface QueueTask<T> {
  id: string;
  fn: () => Promise<T>;
  priority?: number;
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

interface PendingTask<T> extends QueueTask<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export interface AsyncQueueState<T = unknown> {
  pending: Array<PendingTask<T>>;
  running: number;
  completed: number;
  failed: number;
  config: Required<QueueConfig>;
  processing: boolean;
}

export namespace AsyncQueue {
  export function create<T = unknown>(config: Partial<QueueConfig> = {}): AsyncQueueState<T> {
    return {
      pending: [],
      running: 0,
      completed: 0,
      failed: 0,
      config: {
        concurrency: config.concurrency || 5,
        timeout: config.timeout || 30000,
      },
      processing: false,
    };
  }

  export async function add<T>(
    state: AsyncQueueState<T>,
    task: QueueTask<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      state.pending.push({ ...task, resolve, reject });
      state.pending.sort((a, b) => (b.priority || 0) - (a.priority || 0));
      process(state);
    });
  }

  export async function addAll<T>(
    state: AsyncQueueState<T>,
    tasks: QueueTask<T>[]
  ): Promise<T[]> {
    return Promise.all(tasks.map(task => add(state, task)));
  }

  async function process<T>(state: AsyncQueueState<T>): Promise<void> {
    if (state.running >= state.config.concurrency || state.pending.length === 0) {
      return;
    }

    const task = state.pending.shift();
    if (!task) return;

    state.running++;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Task timeout')), state.config.timeout);
      });

      const result = await Promise.race([task.fn(), timeoutPromise]);
      state.completed++;
      task.resolve(result);
    } catch (error) {
      state.failed++;
      task.reject(error as Error);
    } finally {
      state.running--;
      process(state);
    }
  }

  export function getStats<T>(state: AsyncQueueState<T>): QueueStats {
    return {
      pending: state.pending.length,
      running: state.running,
      completed: state.completed,
      failed: state.failed,
    };
  }

  export async function drain<T>(state: AsyncQueueState<T>): Promise<void> {
    while (state.pending.length > 0 || state.running > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  export function clear<T>(state: AsyncQueueState<T>): AsyncQueueState<T> {
    state.pending.forEach(task => {
      task.reject(new Error('Queue cleared'));
    });
    return {
      ...state,
      pending: [],
    };
  }
}

export interface FIFOQueueState<T> {
  items: T[];
}

export namespace FIFOQueue {
  export function create<T>(): FIFOQueueState<T> {
    return { items: [] };
  }

  export function enqueue<T>(state: FIFOQueueState<T>, item: T): FIFOQueueState<T> {
    return {
      items: [...state.items, item],
    };
  }

  export function dequeue<T>(state: FIFOQueueState<T>): { item: T | undefined; state: FIFOQueueState<T> } {
    if (state.items.length === 0) {
      return { item: undefined, state };
    }
    const [item, ...rest] = state.items;
    return {
      item,
      state: { items: rest },
    };
  }

  export function peek<T>(state: FIFOQueueState<T>): T | undefined {
    return state.items[0];
  }

  export function size<T>(state: FIFOQueueState<T>): number {
    return state.items.length;
  }

  export function isEmpty<T>(state: FIFOQueueState<T>): boolean {
    return state.items.length === 0;
  }

  export function clear<T>(state: FIFOQueueState<T>): FIFOQueueState<T> {
    return { items: [] };
  }

  export function toArray<T>(state: FIFOQueueState<T>): T[] {
    return [...state.items];
  }
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number
): (...args: Args) => void {
  let timeoutId: NodeJS.Timeout | undefined;

  return (...args: Args) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number
): (...args: Args) => void {
  let lastCall = 0;

  return (...args: Args) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn(...args);
    }
  };
}
