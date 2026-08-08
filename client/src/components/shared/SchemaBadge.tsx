import { PropsWithChildren } from "react";
import { cn } from "@/lib/utils";

interface SchemaBadgeProps {
  bgcolor: string;
  textcolor?: string;
  className?: string;
}

export function SchemaBadge({ bgcolor, textcolor, className, children }: PropsWithChildren<SchemaBadgeProps>) {
  return (
    <span
      className={cn("inline-block min-w-4 min-h-4 shrink-0 grow-0 rounded-full text-xs font-medium px-2 py-0.5", className)}
      style={{
        backgroundColor: bgcolor,
        color: textcolor,
      }}
      aria-hidden={!children}
    >
      {children}
    </span>
  );
}
