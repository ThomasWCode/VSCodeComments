// Category highlights on commented lines, and the reveal flash.
import * as vscode from 'vscode';
import * as config from './config';
import { keyFor } from './documents';
import { CommentModel, NoteThread } from './model';

export const FLASH_MS = 1500;

export class Decorations implements vscode.Disposable {
  /** One type per category and state, keyed `<id>|open` or `<id>|resolved`. */
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private flashes = new Set<{ type: vscode.TextEditorDecorationType; timer: NodeJS.Timeout }>();

  constructor(private readonly model: CommentModel) {
    this.build();
  }

  dispose(): void {
    for (const t of this.types.values()) {
      t.dispose();
    }
    this.types.clear();
    for (const f of this.flashes) {
      clearTimeout(f.timer);
      f.type.dispose();
    }
    this.flashes.clear();
  }

  /** Recreates the decoration types, after the categories setting changes. */
  rebuild(): void {
    for (const t of this.types.values()) {
      t.dispose();
    }
    this.types.clear();
    this.build();
    this.refreshAll();
  }

  private build(): void {
    for (const c of config.categories()) {
      this.types.set(
        `${c.id}|open`,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: config.rgba(c.colour, 0.14),
          overviewRulerColor: config.rgba(c.colour, 0.9),
          overviewRulerLane: vscode.OverviewRulerLane.Right,
        }),
      );
      this.types.set(
        `${c.id}|resolved`,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: config.rgba(c.colour, 0.05),
          overviewRulerColor: config.rgba(c.colour, 0.35),
          overviewRulerLane: vscode.OverviewRulerLane.Right,
        }),
      );
    }
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refresh(editor);
    }
  }

  refresh(editor: vscode.TextEditor): void {
    const key = keyFor(editor.document.uri);
    const threads = key ? this.model.threads(key) : [];
    const showResolved = config.showResolved();
    const byType = new Map<string, vscode.Range[]>();
    for (const k of this.types.keys()) {
      byType.set(k, []);
    }
    const known = new Set(config.categories().map((c) => c.id));
    const fallback = config.categories()[0].id;
    for (const thread of threads) {
      if (thread.orphaned || (!showResolved && thread.status === 'resolved')) {
        continue;
      }
      const cat = known.has(thread.category) ? thread.category : fallback;
      byType.get(`${cat}|${thread.status}`)?.push(lineRange(thread));
    }
    for (const [k, ranges] of byType) {
      editor.setDecorations(this.types.get(k)!, ranges);
    }
  }

  /** A stronger highlight on a thread's code for FLASH_MS, then back to the normal one. */
  flash(editor: vscode.TextEditor, thread: NoteThread): vscode.TextEditorDecorationType {
    const colour = config.category(thread.category).colour;
    const type = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: config.rgba(colour, 0.4),
      border: `1px solid ${config.rgba(colour, 1)}`,
    });
    editor.setDecorations(type, [lineRange(thread)]);
    const entry = {
      type,
      timer: setTimeout(() => {
        type.dispose();
        this.flashes.delete(entry);
      }, FLASH_MS),
    };
    this.flashes.add(entry);
    return type;
  }

  /** Whether a flash is showing now (for tests). */
  get flashing(): number {
    return this.flashes.size;
  }
}

/** The whole lines a thread covers. */
export function lineRange(thread: NoteThread): vscode.Range {
  return new vscode.Range(thread.anchor.startLine, 0, thread.anchor.endLine, 0);
}
