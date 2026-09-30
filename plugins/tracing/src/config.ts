import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type Config = {
  enabled: boolean;
  public_key?: string;
  secret_key?: string;
  base_url: string;
  environment?: string;
  version?: string;
  user_id?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  trace_seed?: string;
  max_chars: number;
  debug: boolean;
  fail_on_error: boolean;
};

/**
 * Litefuse is normally self-hosted (Doris-backed), and its web app listens on
 * port 3000. Override this for Litefuse Cloud or any other deployment.
 */
const DEFAULTS: Config = {
  enabled: false,
  base_url: "http://localhost:3000",
  max_chars: 20_000,
  debug: false,
  fail_on_error: false,
};

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tagsValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Accept comma-separated values too.
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function metadataValue(value: unknown): Record<string, string> | undefined {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  return Object.fromEntries(
    Object.entries(candidate).map(([key, item]) => [
      key,
      typeof item === "string" ? item : JSON.stringify(item),
    ]),
  );
}

function cleanConfig(value: Record<string, unknown>): Partial<Config> {
  const baseUrl = value.base_url;
  const maxChars = numberValue(value.max_chars);
  return {
    ...(booleanValue(value.enabled) !== undefined ? { enabled: booleanValue(value.enabled) } : {}),
    ...(typeof value.public_key === "string" ? { public_key: value.public_key } : {}),
    ...(typeof value.secret_key === "string" ? { secret_key: value.secret_key } : {}),
    ...(typeof baseUrl === "string" ? { base_url: baseUrl } : {}),
    ...(typeof value.environment === "string" ? { environment: value.environment } : {}),
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.user_id === "string" ? { user_id: value.user_id } : {}),
    ...(tagsValue(value.tags) ? { tags: tagsValue(value.tags) } : {}),
    ...(metadataValue(value.metadata) ? { metadata: metadataValue(value.metadata) } : {}),
    ...(typeof value.trace_seed === "string" ? { trace_seed: value.trace_seed } : {}),
    ...(maxChars && maxChars > 0 ? { max_chars: maxChars } : {}),
    ...(booleanValue(value.debug) !== undefined ? { debug: booleanValue(value.debug) } : {}),
    ...(booleanValue(value.fail_on_error) !== undefined
      ? { fail_on_error: booleanValue(value.fail_on_error) }
      : {}),
  } as Partial<Config>;
}

async function readConfigFile(file: string): Promise<Partial<Config>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? cleanConfig(parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function first(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function readEnvironment(env: Record<string, string | undefined>): Partial<Config> {
  return cleanConfig({
    enabled: first(env, "TRACE_WORKBUDDY_TO_LITEFUSE", "TRACE_TO_LITEFUSE"),
    public_key: first(env, "LITEFUSE_WORKBUDDY_PUBLIC_KEY", "LITEFUSE_PUBLIC_KEY"),
    secret_key: first(env, "LITEFUSE_WORKBUDDY_SECRET_KEY", "LITEFUSE_SECRET_KEY"),
    base_url: first(env, "LITEFUSE_WORKBUDDY_BASE_URL", "LITEFUSE_BASE_URL"),
    environment: first(env, "LITEFUSE_WORKBUDDY_ENVIRONMENT", "LITEFUSE_TRACING_ENVIRONMENT"),
    version: env.LITEFUSE_WORKBUDDY_VERSION,
    user_id: env.LITEFUSE_WORKBUDDY_USER_ID,
    tags: env.LITEFUSE_WORKBUDDY_TAGS,
    metadata: env.LITEFUSE_WORKBUDDY_METADATA,
    trace_seed: env.LITEFUSE_WORKBUDDY_TRACE_SEED,
    max_chars: env.LITEFUSE_WORKBUDDY_MAX_CHARS,
    debug: env.LITEFUSE_WORKBUDDY_DEBUG,
    fail_on_error: env.LITEFUSE_WORKBUDDY_FAIL_ON_ERROR,
  });
}

/** Resolve defaults -> ~/.workbuddy -> project .workbuddy -> environment. */
export async function getConfig(options?: {
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<Config> {
  const home = options?.home ?? process.env.HOME ?? os.homedir();
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const [globalConfig, localConfig] = await Promise.all([
    readConfigFile(path.join(home, ".workbuddy", "litefuse.json")),
    readConfigFile(path.join(cwd, ".workbuddy", "litefuse.json")),
  ]);
  return {
    ...DEFAULTS,
    ...globalConfig,
    ...localConfig,
    ...readEnvironment(env),
  };
}
