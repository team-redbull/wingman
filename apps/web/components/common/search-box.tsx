"use client";

import { useRef } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A search field with a clear button: Escape clears it, then leaves the box.
 * `label` is its accessible name; `className` sizes it.
 */
export function SearchBox({
  value,
  onChange,
  label,
  placeholder = "Search…",
  className,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={cn("relative w-full", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        ref={input}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Inside a dialog, the first Escape clears the search rather than closing it
          if (value) {
            event.stopPropagation();
            onChange("");
          } else event.currentTarget.blur();
        }}
        className="h-8 w-full rounded-lg border bg-card pl-8 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear the search"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
