import { readFileSafe, writeFile } from './fs.js';

/**
 * Inject or replace a marker-delimited section in a CLAUDE.md file.
 *
 * Behavior:
 *   - Both markers present → replace content between them (inclusive).
 *   - Neither marker present → append the block to the end of the file.
 *   - Only one marker present (corrupted) → append the block (safe fallback).
 *   - File does not exist → create it with just the block.
 *
 * @param filePath  Absolute path to the CLAUDE.md file.
 * @param startMarker  Opening marker comment, e.g. `<!-- [teamai:culture:start] -->`.
 * @param endMarker  Closing marker comment.
 * @param block  The full replacement block **including** both markers.
 */
export async function injectClaudeMdSection(
    filePath: string,
    startMarker: string,
    endMarker: string,
    block: string,
): Promise<void> {
    const existing = await readFileSafe(filePath) ?? '';

    const startIdx = existing.indexOf(startMarker);
    const endIdx = existing.indexOf(endMarker);

    let updated: string;
    if (startIdx !== -1 && endIdx !== -1) {
        // Both markers found → replace
        updated = existing.substring(0, startIdx) + block + existing.substring(endIdx + endMarker.length);
    } else {
        // Neither or only one marker → append
        updated = existing.trimEnd() + '\n\n' + block + '\n';
    }

    await writeFile(filePath, updated);
}

/** Remove a marker-delimited managed section while preserving user content. */
export async function removeClaudeMdSection(
    filePath: string,
    startMarker: string,
    endMarker: string,
): Promise<void> {
    const existing = await readFileSafe(filePath);
    if (!existing) return;

    const startIdx = existing.indexOf(startMarker);
    const endIdx = existing.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return;

    const before = existing.substring(0, startIdx).replace(/\n+$/, '\n');
    const after = existing.substring(endIdx + endMarker.length).replace(/^\n+/, '\n');
    await writeFile(filePath, (before + after).trimEnd() + '\n');
}

/**
 * Replace, insert, or remove a marker-delimited managed block inside a string.
 *
 * Unlike injectClaudeMdSection this is pure and can *remove* the block: an
 * empty `body` deletes the START..END span (markers included) and stitches the
 * surrounding user content back together. A non-empty body is wrapped in the
 * markers and either replaces the existing span or is appended after the
 * existing content. Returns a trimmed string; '' when the result would be blank.
 */
export function mergeManagedBlock(
    existing: string,
    startMarker: string,
    endMarker: string,
    body: string,
): string {
    const block = body.trim() !== '' ? `${startMarker}\n${body.trim()}\n${endMarker}` : '';

    const startIdx = existing.indexOf(startMarker);
    const endIdx = existing.indexOf(endMarker);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const before = existing.substring(0, startIdx).replace(/\n+$/, '');
        const after = existing.substring(endIdx + endMarker.length).replace(/^\n+/, '');
        const parts = [before, block, after].filter((p) => p !== '');
        return parts.join('\n\n').trim();
    }

    if (block === '') return existing.trim();
    if (existing.trim() === '') return block;
    return `${existing.trim()}\n\n${block}`;
}
