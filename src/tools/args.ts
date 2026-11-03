export interface StringOptions {
  trim?: boolean;
  allowEmpty?: boolean;
}

export function readString(input: Record<string, unknown>, key: string, options: StringOptions = {}): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`"${key}" must be a string.`);
  const result = options.trim ? value.trim() : value;
  if (options.allowEmpty === false && !result.trim()) throw new Error(`"${key}" must not be empty.`);
  return result;
}

export function readOptionalString(
  input: Record<string, unknown>,
  key: string,
  options: StringOptions = {},
): string | undefined {
  if (input[key] === undefined || input[key] === null) return undefined;
  return readString(input, key, options);
}

export function readOptionalInt(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${key}" must be a number.`);
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function readOptionalBoolean(
  input: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`"${key}" must be a boolean.`);
  return value;
}

export function readStringArray(
  input: Record<string, unknown>,
  key: string,
  min = 1,
  max = 50,
): string[] {
  const value = input[key];
  if (!Array.isArray(value)) throw new Error(`"${key}" must be an array of strings.`);
  const items = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`"${key}[${index}]" must be a non-empty string.`);
    }
    return item.trim();
  });
  if (items.length < min || items.length > max) {
    throw new Error(`"${key}" must contain between ${min} and ${max} items.`);
  }
  return items;
}
