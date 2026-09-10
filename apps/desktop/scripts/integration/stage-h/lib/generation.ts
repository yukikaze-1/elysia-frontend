export interface StageHGenerationEvent {
  event?: string
  generationId?: string | null
  conversationId?: string | null
  [key: string]: unknown
}

export const GENERATION_TERMINAL_EVENTS = ['generation.completed', 'generation.failed', 'generation.cancelled'] as const

/**
 * Generation identity is the only stable correlation key. A terminal frame may
 * omit conversationId, so callers must not fall back to the currently active
 * conversation when collecting a result.
 */
export function generationEventsFor(events: readonly StageHGenerationEvent[], generationId: string): StageHGenerationEvent[] {
  return events.filter((event) => event.generationId === generationId)
}

export function generationStartFor(events: readonly StageHGenerationEvent[], generationId: string): StageHGenerationEvent | undefined {
  return generationEventsFor(events, generationId).find((event) => event.event === 'generation.started')
}

export function generationTerminalFor(events: readonly StageHGenerationEvent[], generationId: string): StageHGenerationEvent | undefined {
  return generationEventsFor(events, generationId).find((event) =>
    (GENERATION_TERMINAL_EVENTS as readonly string[]).includes(event.event ?? '')
  )
}

export function generationConversationId(events: readonly StageHGenerationEvent[], generationId: string): string | undefined {
  const start = generationStartFor(events, generationId)
  return typeof start?.conversationId === 'string' ? start.conversationId : undefined
}
