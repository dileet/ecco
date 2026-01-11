export function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'null';
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJsonStringify(item));
    return '[' + items.join(',') + ']';
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs: string[] = [];
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        pairs.push(JSON.stringify(key) + ':' + canonicalJsonStringify(v));
      }
    }
    return '{' + pairs.join(',') + '}';
  }

  return 'null';
}
