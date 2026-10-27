/**
 * Editor-document helpers for the chat composer: building documents from
 * plain text, inserting text the way typing does, and reading the open `/`
 * or `@` run before the caret.
 */
import type { Editor, JSONContent } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Selection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { composerDocIsEmpty } from './cindy/composerDocState';
import { detectComposerTrigger } from './cindy/composerPalette';
import { plainTextToComposerDocument } from './cindy/composerListDocument';
import type { ComposerTriggerSnapshot } from './cindy/composerRenderGate';

const NO_TRIGGER: ComposerTriggerSnapshot = { kind: 'none' };

const COMPOSER_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
  'hardBreak',
  'bulletList',
  'orderedList',
  'listItem',
  'mentionChip',
  'pastedTextChip',
]);

/**
 * Whether a stored document only uses node types this editor knows, so an
 * older or foreign draft falls back to its text instead of failing to load.
 */
export function isComposerDocJSON(doc: JSONContent): boolean {
  if (!doc || typeof doc !== 'object') return false;
  if (!doc.type || !COMPOSER_NODE_TYPES.has(doc.type)) return false;
  if (doc.marks?.length) return false;
  return (doc.content ?? []).every(isComposerDocJSON);
}

/**
 * The editor document for a draft: its stored document when this editor can
 * load it (chips kept), otherwise one built from its text.
 */
export function composerDocFor(
  text: string,
  doc?: JSONContent | null,
): JSONContent {
  return doc && isComposerDocJSON(doc)
    ? doc
    : plainTextToComposerDocument(text);
}

/** Inline nodes for `text`: line breaks become hard breaks, as when typed. */
function inlineNodesFor(view: EditorView, text: string): PMNode[] {
  const { schema } = view.state;
  const nodes: PMNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push(schema.nodes.hardBreak.create());
    if (line) nodes.push(schema.text(line));
  });
  return nodes;
}

/** Replace the selection with plain text, keeping its line breaks visible. */
export function insertPlainText(view: EditorView, text: string): void {
  const nodes = inlineNodesFor(view, text);
  if (nodes.length === 0) return;
  view.dispatch(
    view.state.tr
      .replaceSelection(new Slice(Fragment.from(nodes), 0, 0))
      .scrollIntoView(),
  );
}

/**
 * Append `text` after what the composer holds, `gap` empty lines apart
 * (none when the composer is empty), with the caret at the end; `focus`
 * also moves focus there.
 */
export function appendComposerText(
  editor: Editor,
  text: string,
  { gap, focus }: { gap: number; focus: boolean },
): void {
  if (composerDocIsEmpty(editor.state.doc)) {
    editor.commands.setContent(plainTextToComposerDocument(text));
  } else {
    const blocks = [
      ...Array.from({ length: gap }, () => ({ type: 'paragraph' })),
      ...(plainTextToComposerDocument(text).content ?? []),
    ];
    editor.commands.insertContentAt(editor.state.doc.content.size, blocks);
  }
  if (focus) {
    editor.commands.focus('end');
  } else {
    editor.commands.command(({ tr }) => {
      tr.setSelection(Selection.atEnd(tr.doc));
      return true;
    });
  }
}

/**
 * The open `/` or `@` run that ends at the caret. A `/` run counts only at the
 * very start of the message; `@` anywhere after whitespace.
 */
export function readComposerTrigger(
  state: EditorState,
): ComposerTriggerSnapshot {
  const { selection } = state;
  if (!selection.empty) return NO_TRIGGER;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return NO_TRIGGER;
  // One character per inline node, so string offsets are document offsets.
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    '\n',
    (node) => (node.type.name === 'hardBreak' ? '\n' : '\uFFFC'),
  );
  const lineStart = before.lastIndexOf('\n') + 1;
  const trigger = detectComposerTrigger(before.slice(lineStart));
  if (trigger.kind === 'none') return NO_TRIGGER;
  if (
    trigger.kind === 'slash' &&
    ($from.depth !== 1 || $from.index(0) !== 0 || lineStart !== 0)
  ) {
    return NO_TRIGGER;
  }
  return { ...trigger, from: $from.start() + lineStart + trigger.from };
}
