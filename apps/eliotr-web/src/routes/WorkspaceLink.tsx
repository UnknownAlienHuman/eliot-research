import type { ComponentPropsWithRef, MouseEventHandler } from "react";
import { useHref, useLinkClickHandler, useLocation } from "react-router";
import type { Destination } from "./location";

export type WorkspaceLinkProps = Omit<
  ComponentPropsWithRef<"a">,
  "href" | "dangerouslySetInnerHTML" | "style" | "aria-current"
> & {
  readonly to: `/${Destination}`;
};

export function WorkspaceLink({
  to,
  target,
  ref,
  className,
  onClick,
  ...anchorProps
}: WorkspaceLinkProps) {
  const href = useHref(to);
  const navigateOnClick = useLinkClickHandler<HTMLAnchorElement>(
    to,
    target === undefined ? {} : { target },
  );
  const location = useLocation();
  const pathname = location.pathname.toLowerCase();
  const destinationPath = to.toLowerCase();
  const isActive = pathname === destinationPath ||
    pathname.startsWith(`${destinationPath}/`);

  const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    onClick?.(event);
    if (!event.defaultPrevented) navigateOnClick(event);
  };

  return (
    <a
      {...anchorProps}
      ref={ref}
      href={href}
      target={target}
      className={isActive ? [className, "active"].filter(Boolean).join(" ") : className}
      aria-current={isActive ? "page" : undefined}
      onClick={handleClick}
    />
  );
}
