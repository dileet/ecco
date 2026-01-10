import {
  createLocalModel,
  createLocalGenerateFn,
  createLocalStreamGenerateFn,
  createLocalEmbedFn,
  isLocalModelState,
  type LocalModelState,
} from '../services/llm'
import type { AgentConfig, GenerateFn, StreamGenerateFn, EmbedFn } from './types'

export interface ModelSetupConfig {
  model?: unknown
  localModel?: AgentConfig['localModel']
  embedding?: AgentConfig['embedding']
  generateFn?: GenerateFn
  streamGenerateFn?: StreamGenerateFn
}

export interface ModelSetupResult {
  modelState: LocalModelState | null
  embeddingModelState: LocalModelState | null
  effectiveGenerateFn: GenerateFn | undefined
  effectiveStreamGenerateFn: StreamGenerateFn | undefined
  effectiveEmbedFn: EmbedFn | undefined
  effectiveModel: unknown
  embeddingModelId: string | undefined
}

export async function setupModels(config: ModelSetupConfig): Promise<ModelSetupResult> {
  let modelState: LocalModelState | null = isLocalModelState(config.model) ? config.model : null
  let embeddingModelState: LocalModelState | null = isLocalModelState(config.embedding) ? config.embedding : null
  let effectiveGenerateFn = config.generateFn
  let effectiveStreamGenerateFn = config.streamGenerateFn
  let effectiveModel = config.model
  let effectiveEmbedFn: EmbedFn | undefined = embeddingModelState
    ? createLocalEmbedFn(embeddingModelState)
    : (!isLocalModelState(config.embedding) ? config.embedding?.embedFn : undefined)

  if (config.localModel) {
    modelState = await createLocalModel({
      modelPath: config.localModel.modelPath,
      contextSize: config.localModel.contextSize,
      gpuLayers: config.localModel.gpuLayers,
      threads: config.localModel.threads,
      embedding: config.localModel.supportsEmbedding,
    })
    effectiveGenerateFn = createLocalGenerateFn(modelState)
    effectiveStreamGenerateFn = createLocalStreamGenerateFn(modelState)
    effectiveModel = config.localModel.modelName ?? config.localModel.modelPath
  }

  const embeddingModelId = embeddingModelState
    ? embeddingModelState.config.modelPath
    : isLocalModelState(config.embedding) ? undefined : config.embedding?.modelId

  return {
    modelState,
    embeddingModelState,
    effectiveGenerateFn,
    effectiveStreamGenerateFn,
    effectiveEmbedFn,
    effectiveModel,
    embeddingModelId,
  }
}

export function createEmbedFunction(
  effectiveEmbedFn: EmbedFn | undefined,
  hasLocalModel: boolean,
  localModelConfig: AgentConfig['localModel'],
  modelState: LocalModelState | null
): ((texts: string[]) => Promise<number[][]>) | null {
  if (effectiveEmbedFn) {
    return async (texts: string[]): Promise<number[][]> => effectiveEmbedFn(texts)
  }
  if (hasLocalModel && localModelConfig?.supportsEmbedding && modelState) {
    return async (texts: string[]): Promise<number[][]> => createLocalEmbedFn(modelState)(texts)
  }
  return null
}
