export function serialize(value) {
  if (value === undefined) {
    throw new TypeError('redis-light: cannot store undefined (use del() instead)');
  }
  return JSON.stringify(value);
}

// Values written by other tools may not be JSON - return them as plain strings.
export function deserialize(raw) {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function toMs(seconds) {
  return Math.max(1, Math.round(seconds * 1000));
}
