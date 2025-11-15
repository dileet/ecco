export function compose<T>(...fns: Array<(value: T) => T | Promise<T>>): (value: T) => Promise<T> {
  return async (initialValue: T) => {
    let result = initialValue;
    for (const fn of fns) {
      result = await fn(result);
    }
    return result;
  };
}

export function composeWith<T, TContext extends any[]>(
  ...fns: Array<(value: T, ...context: TContext) => T | Promise<T>>
): (value: T, ...context: TContext) => Promise<T> {
  return async (initialValue: T, ...context: TContext) => {
    let result = initialValue;
    for (const fn of fns) {
      result = await fn(result, ...context);
    }
    return result;
  };
}

export async function pipe<T>(
  value: T,
  ...fns: Array<(value: T) => T | Promise<T>>
): Promise<T> {
  return compose(...fns)(value);
}
