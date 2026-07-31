export interface SystemJob {
  readonly name: string;
}

export function processSystemJob(job: SystemJob): Readonly<{ ok: true }> {
  if (job.name !== "foundation.noop") {
    throw new Error(`Unsupported M1 job: ${job.name}`);
  }
  return { ok: true };
}
