export function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
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
    const pairs = keys.map((key) => {
      const v = (value as Record<string, unknown>)[key];
      return JSON.stringify(key) + ':' + canonicalJsonStringify(v);
    });
    return '{' + pairs.join(',') + '}';
  }

  return 'null';
}
