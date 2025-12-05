const isDebugEnabled = (): boolean =>
  process.env.DEBUG === 'true' || process.env.DEBUG === '1'

export const debug = (category: string, ...args: unknown[]): void => {
  if (isDebugEnabled()) {
    console.log(`[DEBUG ${category}]`, ...args)
  }
}
