import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  submitLabel?: string;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
};

/**
 * In-app text-input modal. Exists because Tauri v2 WKWebView no-ops
 * `window.prompt` — `prompt` is a Web-platform API that Chromium ships
 * but WKWebView does not, so the browser-native dialog never appears
 * and the call silently returns null. Every place that previously
 * called `window.prompt` should route through this instead.
 */
export function PromptModal({
  open,
  title,
  label,
  placeholder,
  initialValue,
  submitLabel,
  onSubmit,
  onClose,
}: Props) {
  const [value, setValue] = useState(initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue ?? "");
    setError(null);
    setBusy(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, initialValue]);

  if (!open) return null;

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="modal-header">
          {title}
          <button className="close-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {label && <span>{label}</span>}
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              disabled={busy}
            />
          </label>
          {error && (
            <div style={{ color: "var(--color-danger, #f38ba8)", fontSize: 12, marginTop: 8 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={!canSubmit}>
            {submitLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
