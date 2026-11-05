// Shapes the seek:embed CLI reply. Split from main.ts so the formatting is testable without Obsidian.

export function embedCliReply(text: string, vector: ArrayLike<number>, asJson: boolean): string {
    const vec = Array.from(vector);
    if (!vec.every(Number.isFinite)) throw new Error('embedder returned a non-finite vector');
    // Dimension and norm let a caller sanity-check the vector without knowing the model.
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    return asJson
        ? JSON.stringify({ text, dim: vec.length, norm, vector: vec })
        : `Seek · embedding · dim ${vec.length} · norm ${norm.toFixed(4)}\n${JSON.stringify(vec)}`;
}
