import * as fs from "node:fs/promises";

const sidecarPath = (transcript: string) => `${transcript}.litefuse-workbuddy`;

export async function loadUploadedTurnIds(transcript: string): Promise<Set<string>> {
  try {
    return new Set(
      (await fs.readFile(sidecarPath(transcript), "utf8")).split("\n").filter(Boolean),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export async function markTurnUploaded(transcript: string, turnId: string): Promise<void> {
  try {
    await fs.appendFile(sidecarPath(transcript), `${turnId}\n`, "utf8");
  } catch {
    // Best effort. A failed write can only cause a duplicate upload later.
  }
}
