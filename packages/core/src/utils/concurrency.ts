export interface AsyncMutex {
  acquire: () => Promise<() => void>
  isLocked: () => boolean
  queueLength: () => number
}

export function createAsyncMutex(): AsyncMutex {
  let locked = false
  const queue: Array<() => void> = []

  const acquire = (): Promise<() => void> =>
    new Promise((resolve) => {
      const tryAcquire = () => {
        if (!locked) {
          locked = true
          resolve(() => {
            locked = false
            const next = queue.shift()
            if (next) next()
          })
        } else {
          queue.push(tryAcquire)
        }
      }
      tryAcquire()
    })

  return {
    acquire,
    isLocked: () => locked,
    queueLength: () => queue.length,
  }
}
