import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes } from "react";
import { MaterialSymbol, type MaterialSymbolName } from "../catalog/MaterialSymbol";
import { captureFocus, restoreFocus, type FocusCapture } from "./focus";
import "./primitives.css";

export type ButtonVariant = "primary" | "tonal" | "text";
export type StatusTone = "neutral" | "error";

type NativeButtonAttributes = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "dangerouslySetInnerHTML">;

export type ButtonProps = NativeButtonAttributes & {
  readonly variant?: ButtonVariant;
  readonly icon?: MaterialSymbolName;
  readonly loading?: boolean;
  readonly className?: string;
};

export function Button({
  variant = "primary",
  icon,
  loading = false,
  disabled,
  onClick,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = ["er-button", `er-button--${variant}`, className]
    .filter((value) => value !== undefined && value !== "")
    .join(" ");
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading ? true : undefined}
      onClick={onClick}
    >
      {icon === undefined ? null : <MaterialSymbol name={icon} />}
      {children}
    </button>
  );
}

export type IconButtonProps = Omit<NativeButtonAttributes, "children"> & {
  readonly label: string;
  readonly icon: MaterialSymbolName;
  readonly className?: string;
};

export function IconButton({
  label,
  icon,
  disabled,
  onClick,
  type = "button",
  className,
  ...rest
}: IconButtonProps) {
  const classes = ["er-icon-button", className]
    .filter((value) => value !== undefined && value !== "")
    .join(" ");
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <MaterialSymbol name={icon} />
    </button>
  );
}

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "dangerouslySetInnerHTML"> & {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly className?: string;
};

export function Field({
  label,
  hint,
  error,
  required,
  id,
  className,
  ...inputRest
}: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const classes = ["er-field__control", className]
    .filter((value) => value !== undefined && value !== "")
    .join(" ");
  const describedBy = error === undefined ? (hint === undefined ? undefined : hintId) : errorId;
  return (
    <div className="er-field">
      <label className="er-field__label" htmlFor={controlId}>
        {label}
      </label>
      <input
        {...inputRest}
        id={controlId}
        className={classes}
        required={required}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
      />
      {error === undefined ? null : (
        <span className="er-field__error" id={errorId}>
          {error}
        </span>
      )}
      {error === undefined && hint === undefined ? null : (
        <span className="er-field__hint" id={hintId} hidden={error !== undefined}>
          {hint}
        </span>
      )}
    </div>
  );
}

export type StatusProps = {
  readonly tone?: StatusTone;
  readonly icon?: MaterialSymbolName;
  /** Static labels stay quiet; live operation feedback opts in explicitly. */
  readonly announce?: boolean;
  readonly children: string;
};

export function Status({ tone = "neutral", icon = tone === "error" ? "close" : "evidence", announce = false, children }: StatusProps) {
  return (
    <span className={`er-status er-status--${tone}`} role={announce ? "status" : undefined} aria-live={announce ? "polite" : undefined}>
      <MaterialSymbol name={icon} />
      <span>{children}</span>
    </span>
  );
}

export type DialogProps = {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children?: React.ReactNode;
};

export function Dialog({ open, title, onClose, children }: DialogProps) {
  const nodeRef = useRef<HTMLDialogElement | null>(null);
  const openerCaptureRef = useRef<FocusCapture>({ node: null });
  useEffect(() => {
    const node = nodeRef.current;
    if (node === null) return undefined;
    if (open) {
      if (!node.open) {
        openerCaptureRef.current = captureFocus();
        node.showModal();
      }
      return () => {
        if (node.open) node.close();
        restoreFocus(openerCaptureRef.current);
        openerCaptureRef.current = { node: null };
      };
    }
    if (node.open) node.close();
    restoreFocus(openerCaptureRef.current);
    openerCaptureRef.current = { node: null };
    return undefined;
  }, [open]);

  const handleCancel = (event: React.SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onClose();
  };

  const handleBackdrop = (event: React.MouseEvent<HTMLDialogElement>) => {
    const node = nodeRef.current;
    if (!node || event.target !== node) return;
    const bounds = node.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  };

  return (
    <dialog
      ref={nodeRef}
      className="er-dialog"
      aria-label={title}
      onCancel={handleCancel}
      onClick={handleBackdrop}
    >
      <h2 className="er-dialog__title">{title}</h2>
      <div className="er-dialog__body">{children}</div>
    </dialog>
  );
}
