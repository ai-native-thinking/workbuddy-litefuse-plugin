export function readStdin<T>(): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (buffer += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(buffer.trim()) as T);
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.once("error", reject);
  });
}

export function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (["number", "boolean", "bigint"].includes(typeof value)) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
}

let debugEnabled = false;
export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function debugLog(...args: unknown[]): void {
  if (debugEnabled) console.error("[litefuse-workbuddy]", ...args);
}
