"use client";

export const SHORTCUTS: [string, string][] = [
  ["n", "New task"],
  ["/", "Search"],
  ["1 – 4", "Today / This Week / This Month / Overdue"],
  ["j / k  or  ↓ / ↑", "Move selection"],
  ["x", "Mark selected done / not done"],
  ["e", "Edit selected"],
  ["Delete", "Delete selected"],
  ["c", "Show / hide completed"],
  ["s", "Settings"],
  ["Esc", "Close form, settings or search"],
  ["?", "This help"],
];

export function ShortcutList() {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      {SHORTCUTS.map(([keys, label]) => (
        <div key={keys} className="contents">
          <dt>
            <kbd className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-800">
              {keys}
            </kbd>
          </dt>
          <dd className="text-zinc-600 dark:text-zinc-300">{label}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-zinc-900"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Keyboard shortcuts
          </h2>
          <button
            onClick={onClose}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium dark:border-zinc-700"
          >
            Close
          </button>
        </div>
        <ShortcutList />
      </div>
    </div>
  );
}
