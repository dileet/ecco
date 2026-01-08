import { getLlama, type Llama, type LlamaModel, type LlamaContext } from 'node-llama-cpp'
import type { GenerateFn, StreamGenerateFn, EmbedFn } from '../agent/types'
import { createAsyncMutex, type AsyncMutex } from '../utils/concurrency'

export interface LocalModelConfig {
  modelPath: string
  contextSize?: number
  gpuLayers?: number
  threads?: number
  embedding?: boolean
}

export interface LocalModelState {
  readonly _tag: 'LocalModelState'
  llama: Llama
  model: LlamaModel
  context: LlamaContext
  config: LocalModelConfig
  mutex: AsyncMutex
  disposed: boolean
}

export function isLocalModelState(value: unknown): value is LocalModelState {
  return value !== null && typeof value === 'object' && '_tag' in value && value._tag === 'LocalModelState'
}

export async function createLocalModel(config: LocalModelConfig): Promise<LocalModelState> {
  const llama = await getLlama()

  const model = await llama.loadModel({
    modelPath: config.modelPath,
  })

  const context = await model.createContext({
    contextSize: config.contextSize,
    threads: config.threads,
  })

  return {
    _tag: 'LocalModelState' as const,
    llama,
    model,
    context,
    config,
    mutex: createAsyncMutex(),
    disposed: false,
  }
}

export async function generate(
  state: LocalModelState,
  options: { system: string; prompt: string }
): Promise<{ text: string }> {
  if (state.disposed) {
    throw new Error('Model is disposed')
  }

  const { LlamaChatSession } = await import('node-llama-cpp')

  const release = await state.mutex.acquire()

  if (state.disposed) {
    release()
    throw new Error('Model is disposed')
  }

  const sequence = state.context.getSequence()
  const session = new LlamaChatSession({
    contextSequence: sequence,
    systemPrompt: options.system,
  })

  try {
    const response = await session.prompt(options.prompt)
    return { text: response }
  } finally {
    await sequence.dispose()
    release()
  }
}

export async function* streamGenerate(
  state: LocalModelState,
  options: { system: string; prompt: string }
): AsyncGenerator<{ text: string; tokens?: number }> {
  if (state.disposed) {
    throw new Error('Model is disposed')
  }

  const { LlamaChatSession } = await import('node-llama-cpp')

  const release = await state.mutex.acquire()

  if (state.disposed) {
    release()
    throw new Error('Model is disposed')
  }

  const sequence = state.context.getSequence()
  const session = new LlamaChatSession({
    contextSequence: sequence,
    systemPrompt: options.system,
  })

  const chunks: Array<{ text: string; tokens: number }> = []
  const waiters: Array<() => void> = []
  let done = false

  const notifyWaiter = (): void => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter()
    }
  }

  const waitForChunk = async (): Promise<void> => {
    if (chunks.length > 0 || done) {
      return
    }

    await new Promise<void>((resolve) => {
      waiters.push(resolve)
      if (chunks.length > 0 || done) {
        const waiter = waiters.pop()
        if (waiter) {
          waiter()
        }
      }
    })
  }

  const promptPromise = session.prompt(options.prompt, {
    onTextChunk: (text) => {
      chunks.push({ text, tokens: 1 })
      notifyWaiter()
    },
  })

  promptPromise.finally(() => {
    done = true
    notifyWaiter()
  })

  try {
    while (!done || chunks.length > 0) {
      if (chunks.length > 0) {
        yield chunks.shift()!
      } else if (!done) {
        await waitForChunk()
      }
    }

    await promptPromise
  } finally {
    await sequence.dispose()
    release()
  }
}

export async function embed(
  state: LocalModelState,
  texts: string[]
): Promise<number[][]> {
  if (state.disposed) {
    throw new Error('Model is disposed')
  }

  if (!state.config.embedding) {
    throw new Error('Model was not loaded with embedding support. Use a model that supports embeddings.')
  }

  const release = await state.mutex.acquire()

  if (state.disposed) {
    release()
    throw new Error('Model is disposed')
  }

  let embeddingContext: Awaited<ReturnType<LlamaModel['createEmbeddingContext']>> | null = null
  const embeddings: number[][] = []

  try {
    embeddingContext = await state.model.createEmbeddingContext()
    for (const text of texts) {
      const result = await embeddingContext.getEmbeddingFor(text)
      embeddings.push(Array.from(result.vector))
    }
  } finally {
    if (embeddingContext) {
      await embeddingContext.dispose()
    }
    release()
  }

  return embeddings
}

export function createLocalGenerateFn(state: LocalModelState): GenerateFn {
  return async (options) => {
    return generate(state, {
      system: options.system,
      prompt: options.prompt,
    })
  }
}

export function createLocalStreamGenerateFn(state: LocalModelState): StreamGenerateFn {
  return async function* (options) {
    if (state.disposed) {
      throw new Error('Model is disposed')
    }

    const { LlamaChatSession } = await import('node-llama-cpp')

    const release = await state.mutex.acquire()

    if (state.disposed) {
      release()
      throw new Error('Model is disposed')
    }

    const sequence = state.context.getSequence()
    const session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt: options.system,
    })

    const chunks: Array<{ text: string; tokens: number }> = []
    const waiters: Array<() => void> = []
    let done = false

    const notifyWaiter = (): void => {
      const waiter = waiters.shift()
      if (waiter) {
        waiter()
      }
    }

    const waitForChunk = async (): Promise<void> => {
      if (chunks.length > 0 || done) {
        return
      }

      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        if (chunks.length > 0 || done) {
          const waiter = waiters.pop()
          if (waiter) {
            waiter()
          }
        }
      })
    }

    const promptPromise = session.prompt(options.prompt, {
      onTextChunk: (text) => {
        chunks.push({ text, tokens: 1 })
        notifyWaiter()
      },
    })

    promptPromise.finally(() => {
      done = true
      notifyWaiter()
    })

    try {
      while (!done || chunks.length > 0) {
        if (chunks.length > 0) {
          yield chunks.shift()!
        } else if (!done) {
          await waitForChunk()
        }
      }

      await promptPromise
    } finally {
      await sequence.dispose()
      release()
    }
  }
}

export function createLocalEmbedFn(state: LocalModelState): EmbedFn {
  return async (texts) => {
    return embed(state, texts)
  }
}

const UNLOAD_TIMEOUT_MS = 30000
const UNLOAD_POLL_INTERVAL_MS = 100

export async function unloadModel(state: LocalModelState): Promise<void> {
  state.disposed = true

  const deadline = Date.now() + UNLOAD_TIMEOUT_MS
  while (state.mutex.isLocked() || state.mutex.queueLength() > 0) {
    if (Date.now() >= deadline) {
      console.warn('[llm] unloadModel timeout waiting for mutex, forcing disposal')
      break
    }
    await new Promise((resolve) => setTimeout(resolve, UNLOAD_POLL_INTERVAL_MS))
  }

  await state.context.dispose()
  await state.model.dispose()
}
