export async function repeat(
  times: number,
  action: (iteration: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(times) || times < 1 || times > 1_000) {
    throw new RangeError("times must be an integer between 1 and 1000");
  }

  for (let iteration = 0; iteration < times; iteration += 1) {
    await action(iteration);
  }
}
