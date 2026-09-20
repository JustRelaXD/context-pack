import { useState } from "react";

interface AddItemProps {
  onAdd: (name: string) => void;
  busy: boolean;
}

/**
 * Add something that isn't on the list yet.
 *
 * Two rules make this worth having rather than being a settings screen. It is
 * inline, so it never costs a navigation; and it adds *and* marks the item packed
 * in one step, because the only reason to type a name here is that you are
 * holding the thing and want it remembered. Asking a second time whether you have
 * it would be the kind of question that makes people stop using an app.
 */
export function AddItem({ onAdd, busy }: AddItemProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  if (!open) {
    return (
      <button type="button" className="add-toggle" onClick={() => setOpen(true)}>
        ＋ Add something else you're taking
      </button>
    );
  }

  return (
    <form
      className="add-form"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || busy) return;
        onAdd(trimmed);
        setName("");
        setOpen(false);
      }}
    >
      <input
        className="input"
        value={name}
        autoFocus
        autoComplete="off"
        enterKeyHint="done"
        placeholder="Retainer, umbrella, lab coat…"
        aria-label="Name of the item you're taking"
        onChange={(event) => setName(event.target.value)}
      />
      <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
        Add
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          setOpen(false);
          setName("");
        }}
      >
        Cancel
      </button>
    </form>
  );
}
