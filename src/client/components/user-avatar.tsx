import { useRef } from "react";
import { cn } from "@/client/lib/cn";
import { initials } from "@/client/lib/initials";
import { useAvatarSrc } from "@/client/arena3/avatar";

export type UserAvatarProps = {
  name?: string | null;
  url?: string | null;
  className?: string;
  initialsClassName?: string;
  alt?: string;
};

/**
 * Renders an authenticated user avatar image via blob URL or falls back to initials.
 * Lazy loads offscreen avatars using IntersectionObserver and loading="lazy".
 */
export function UserAvatar({
  name,
  url,
  className,
  initialsClassName,
  alt,
}: UserAvatarProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const src = useAvatarSrc(url, containerRef);

  return (
    <span
      ref={containerRef}
      className={cn(
        "relative inline-grid size-full place-items-center overflow-hidden rounded-full select-none",
        !src && "bg-wood",
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt={alt ?? name ?? "Avatar"}
          className="size-full rounded-full object-cover transition-opacity duration-200 motion-reduce:transition-none"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className={cn("grid size-full place-items-center font-display", initialsClassName)}>
          {initials(name ?? undefined)}
        </span>
      )}
    </span>
  );
}
