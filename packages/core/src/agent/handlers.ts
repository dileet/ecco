import { z } from 'zod'
import type { Message, Constitution } from '../types'
import type { MessageContext, GenerateFn, StreamGenerateFn } from './types'
import { formatConstitutionForSystemPrompt } from '../protocol/constitution'

const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

const ContentPartSchema = z.union([
  z.string(),
  z.array(TextPartSchema),
])

const PromptMessageSchema = z.object({
  role: z.string(),
  content: ContentPartSchema,
})

const PromptArraySchema = z.array(PromptMessageSchema)

export function extractPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt

  const parsed = PromptArraySchema.safeParse(prompt)
  if (!parsed.success) return ''

  const texts: string[] = []
  for (const msg of parsed.data) {
    if (msg.role !== 'user') continue

    if (typeof msg.content === 'string') {
      texts.push(msg.content)
    } else {
      for (const part of msg.content) {
        texts.push(part.text)
      }
    }
  }
  return texts.join(' ')
}

interface LLMHandlerConfig {
  systemPrompt: string
  model: unknown
  generateFn?: GenerateFn
  streamGenerateFn?: StreamGenerateFn
  constitution?: Constitution
}

export function createLLMHandler(
  config: LLMHandlerConfig
): (msg: Message, ctx: MessageContext) => Promise<void> {
  const { systemPrompt, model, generateFn, streamGenerateFn, constitution } = config

  if (!generateFn && !streamGenerateFn) {
    throw new Error('Either generateFn or streamGenerateFn must be provided')
  }

  const constitutionPrefix = constitution ? formatConstitutionForSystemPrompt(constitution) : ''
  const fullSystemPrompt = constitutionPrefix + systemPrompt

  return async (msg: Message, ctx: MessageContext): Promise<void> => {
    const payload = msg.payload as { prompt?: string } | undefined
    const promptText = payload?.prompt ?? ''

    if (!promptText) {
      await ctx.reply({ error: 'No prompt provided' }, 'agent-response')
      return
    }

    const genOptions = {
      model,
      system: fullSystemPrompt,
      prompt: promptText,
    }

    try {
      if (streamGenerateFn) {
        await ctx.streamResponse(async function* () {
          const generator = streamGenerateFn(genOptions)
          for await (const chunk of generator) {
            yield { text: chunk.text, tokens: chunk.tokens ?? 0 }
          }
        })
      } else if (generateFn) {
        const result = await generateFn(genOptions)
        await ctx.reply(
          { requestId: msg.id, response: { text: result.text, finishReason: 'stop' } },
          'agent-response'
        )
      }
    } catch (error) {
      await ctx.reply(
        { requestId: msg.id, response: { error: String(error) } },
        'agent-response'
      )
    }
  }
}

const AgentRequestSchema = z.object({
  type: z.literal('agent-request'),
})

export function isAgentRequest(msg: Message): boolean {
  return AgentRequestSchema.safeParse(msg).success
}
