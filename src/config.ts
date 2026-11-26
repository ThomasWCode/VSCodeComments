// Settings shared by the modules, read fresh each time so changes apply at once.
import * as vscode from 'vscode';

export interface Category {
  id: string;
  label: string;
  colour: string;
}

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'note', label: 'Note', colour: '#3b82f6' },
  { id: 'question', label: 'Question', colour: '#a855f7' },
  { id: 'todo', label: 'To do', colour: '#f59e0b' },
  { id: 'bug', label: 'Bug', colour: '#ef4444' },
  { id: 'idea', label: 'Idea', colour: '#22c55e' },
];

function section(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('marginNotes');
}

export function categories(): Category[] {
  const raw = section().get<unknown>('categories');
  if (!Array.isArray(raw)) {
    return DEFAULT_CATEGORIES;
  }
  const valid = raw.filter(
    (c): c is Category =>
      typeof c === 'object' && c !== null && typeof c.id === 'string' && c.id !== '' && typeof c.colour === 'string',
  );
  const seen = new Set<string>();
  const result = valid
    .filter((c) => !seen.has(c.id) && seen.add(c.id))
    .map((c) => ({ id: c.id, label: typeof c.label === 'string' && c.label ? c.label : c.id, colour: c.colour }));
  return result.length > 0 ? result : DEFAULT_CATEGORIES;
}

/** A thread's category; one no longer in the settings shows as the first category's colour. */
export function category(id: string): Category {
  const all = categories();
  return all.find((c) => c.id === id) ?? { ...all[0], id, label: id };
}

export function defaultCategoryId(): string {
  const all = categories();
  return all.find((c) => c.id === 'note')?.id ?? all[0].id;
}

export function storageFolder(): string {
  const value = (section().get<string>('storageFolder') ?? '').trim().replace(/[\\/]+$/, '');
  return value === '' ? '.codecomments' : value;
}

export function commitComments(): boolean {
  return section().get<boolean>('commitComments') === true;
}

export function showResolved(): boolean {
  return section().get<boolean>('showResolved') !== false;
}

export async function setShowResolved(value: boolean): Promise<void> {
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await section().update('showResolved', value, target);
}

export function contextLines(): number {
  const n = section().get<number>('contextLines');
  return typeof n === 'number' && n >= 0 ? Math.min(20, Math.floor(n)) : 2;
}

export function autoOpenMargin(): boolean {
  return section().get<boolean>('autoOpenMargin') === true;
}

export function expandInlineOnReveal(): boolean {
  return section().get<boolean>('expandInlineOnReveal') !== false;
}

/** Parses #rgb or #rrggbb; undefined for anything else. */
export function parseHex(colour: string): { r: number; g: number; b: number } | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (!m) {
    return undefined;
  }
  let hex = m[1];
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** A category colour at an opacity, as rgba(); grey when the colour can't be read. */
export function rgba(colour: string, alpha: number): string {
  const c = parseHex(colour) ?? { r: 128, g: 128, b: 128 };
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}
