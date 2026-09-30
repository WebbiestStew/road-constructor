import type { ReactNode } from "react";

/** Full-page friendly message used for crashes and unsupported browsers. Plain elements only so it can also render inside global-error. */
export default function FallbackScreen({
  title,
  children,
  actionLabel,
  onAction,
}: {
  title: string;
  children: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center p-6">
      <div className="hud-panel max-w-md p-6 text-center">
        <div className="mb-2 text-4xl" aria-hidden>
          🚧
        </div>
        <h1 className="font-display mb-2 text-2xl font-extrabold text-[#241b3d]">{title}</h1>
        <div className="mb-4 text-sm leading-relaxed text-zinc-700">{children}</div>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 px-5 py-2 text-sm font-bold text-white shadow"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
