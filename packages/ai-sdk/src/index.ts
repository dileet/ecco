export {
  createState as createEccoState,
  parseResponse as parseEccoResponse,
  doGenerate as eccoDoGenerate,
  doStream as eccoDoStream,
  createEccoProvider,
} from './provider';

export type {
  EccoProviderConfig,
  EccoLanguageModelState,
  EccoLanguageModel,
  EccoGenerateResult,
  EccoStreamResult,
} from './provider';

export {
  createState as createMultiAgentState,
  extractResult as extractMultiAgentResult,
  aggregateUsage as aggregateMultiAgentUsage,
  buildMetadata as buildMultiAgentMetadata,
  doGenerate as multiAgentDoGenerate,
  doStream as multiAgentDoStream,
  getLoadStatistics as getMultiAgentLoadStatistics,
  resetLoadStatistics as resetMultiAgentLoadStatistics,
  createMultiAgentProvider,
} from './multi-agent-provider';

export type {
  MultiAgentProviderConfig,
  MultiAgentLanguageModelState,
  MultiAgentLanguageModel,
  MultiAgentGenerateResult,
  MultiAgentStreamResult,
} from './multi-agent-provider';

export { setupEmbeddingProvider, type EmbeddingProviderConfig } from './embedding-provider';
export { isAgentRequest } from './types';
export type { AgentRequestPayload, AgentResponsePayload } from './types';
