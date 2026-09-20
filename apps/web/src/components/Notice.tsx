export interface Notice {
  kind: "info" | "error";
  text: string;
}

/**
 * A single line of feedback, pinned above the content.
 *
 * It is `role="status"` rather than a modal because nothing here is worth
 * interrupting someone who is halfway out of the door: "Got it — no laptop
 * today" should be readable and ignorable.
 */
export function NoticeBar({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div className={`notice notice-${notice.kind}`} role="status">
      <p>{notice.text}</p>
      <button type="button" className="notice-x" aria-label="Dismiss" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}
