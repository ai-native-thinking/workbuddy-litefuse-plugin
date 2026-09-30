import { getConfig } from "./config.js";
import { setupInstrumentation } from "./instrumentation.js";
import { convertTranscript } from "./trace.js";
import type { HookInput } from "./types.js";
import { debugLog, readStdin, setDebug } from "./utils.js";

let failOnError = process.env.LITEFUSE_WORKBUDDY_FAIL_ON_ERROR === "true";

export async function runHook(): Promise<void> {
  let hookInput: HookInput;
  try {
    hookInput = await readStdin<HookInput>();
  } catch {
    return;
  }

  const config = await getConfig({ cwd: hookInput.cwd ?? process.cwd() });
  setDebug(config.debug);
  failOnError = config.fail_on_error;
  if (!config.enabled) {
    debugLog("tracing disabled; set TRACE_WORKBUDDY_TO_LITEFUSE=true to enable");
    return;
  }
  if (!config.public_key || !config.secret_key) {
    debugLog("missing Litefuse public or secret key; skipping");
    return;
  }
  if (!hookInput.transcript_path) {
    debugLog("Stop hook payload has no transcript_path; skipping");
    return;
  }

  const instrumentation = setupInstrumentation(config);
  try {
    await convertTranscript(hookInput.transcript_path, { config });
  } catch (error) {
    debugLog("failed to convert WorkBuddy transcript", error);
    if (config.fail_on_error) throw error;
  } finally {
    try {
      await instrumentation.shutdown();
    } catch (error) {
      debugLog("failed to flush Litefuse spans", error);
      if (config.fail_on_error) throw error;
    }
  }
}

runHook().catch((error) => {
  if (process.env.LITEFUSE_WORKBUDDY_DEBUG === "true") {
    console.error("[litefuse-workbuddy] fatal", error);
  }
  if (failOnError) process.exitCode = 1;
});
