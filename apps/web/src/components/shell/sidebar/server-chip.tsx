import type { DesktopServerRef } from "@codeden/contracts";
import { ChevronsUpDown, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { platform } from "@/lib/platform";

/** Which server this desktop window shows (null in a browser, or before the app answers). */
function useDesktopServer(): DesktopServerRef | null {
  const [server, setServer] = useState<DesktopServerRef | null>(null);
  useEffect(() => {
    let live = true;
    void platform.serverSwitcher?.current().then((s) => live && setServer(s));
    return () => {
      live = false;
    };
  }, []);
  return server;
}

/**
 * The header chip of the desktop app (§17): names the server this window shows ("This Mac",
 * "Omarchy") and opens the app's native menu to switch to another. Nothing in a browser tab.
 * `compact` is the icon-only form for the collapsed sidebar.
 */
export function ServerChip({ compact = false }: { compact?: boolean }) {
  const server = useDesktopServer();
  const switcher = platform.serverSwitcher;
  if (!switcher || !server) return null;
  const label = `Server: ${server.name}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => switcher.showMenu()}
          aria-label={`${label}. Switch server`}
          className={
            compact
              ? "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              : "flex h-6 min-w-0 max-w-[9rem] items-center gap-1 rounded-md border border-sidebar-border bg-background/40 px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-input hover:text-foreground"
          }
        >
          {compact ? (
            <Server className="size-4" />
          ) : (
            <>
              <span className="truncate">{server.name}</span>
              <ChevronsUpDown className="size-3 shrink-0" />
            </>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
