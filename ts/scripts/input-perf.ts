export async function settledFrameCount(readFrameCount: () => Promise<number>): Promise<number> {
    const deadline = Date.now() + 1_000;
    let previous = await readFrameCount();
    let stableSamples = 0;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        const current = await readFrameCount();
        if (current === previous) {
            stableSamples += 1;
            if (stableSamples >= 4) return current;
        } else {
            previous = current;
            stableSamples = 0;
        }
    }
    throw new Error("input fixture did not reach an idle frame boundary within 1s");
}
