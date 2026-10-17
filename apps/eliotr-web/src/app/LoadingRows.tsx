import { Status } from "@eliotr/ui";
import "./loading-rows.css";

/**
 * A list that is still loading: one quiet line saying what is being read, then placeholder rows in the
 * list's own rhythm, so the page does not sit empty or jump when the rows arrive. Not a live region.
 */
export function LoadingRows({ label, rows = 3 }: { readonly label: string; readonly rows?: number }) {
  return <div className="er-loading-rows" data-loading="true">
    <Status icon="pending">{label}</Status>
    {Array.from({ length: rows }, (_, index) => <span key={index} className="er-loading-rows__row" aria-hidden="true">
      <span /><span />
    </span>)}
  </div>;
}
