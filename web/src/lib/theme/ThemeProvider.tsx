// Light and dark following the system preference, with a manual toggle stored locally (SPEC §9.3).
//
// The manual choice is written to `document.documentElement`'s `data-theme`, which `tokens.css` reads; the
// `system` choice writes nothing, so `prefers-color-scheme` decides. Only the preference is stored, and only
// in local storage.

import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState} from "react";

export const THEME_STORAGE_KEY = "luckydraw.theme";

export type ThemeMode = "system" | "light" | "dark";

const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

export type ThemeContextValue = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Cycles system -> light -> dark -> system, which is what the single toggle control does. */
  cycle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(storage: Pick<Storage, "getItem"> | null): ThemeMode {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY);
    return MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : "system";
  } catch {
    return "system";
  }
}

export function ThemeProvider({
  children,
  storage,
}: {
  children: ReactNode;
  storage?: Pick<Storage, "getItem" | "setItem">;
}) {
  const store = useMemo(
    () => storage ?? (typeof window === "undefined" ? null : window.localStorage),
    [storage],
  );
  const [mode, setModeState] = useState<ThemeMode>(() => readStored(store));

  useEffect(() => {
    const root = document.documentElement;
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
  }, [mode]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      try {
        store?.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // A blocked storage costs the preference on the next visit, nothing more.
      }
    },
    [store],
  );

  const cycle = useCallback(() => {
    setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length] ?? "system");
  }, [mode, setMode]);

  const value = useMemo<ThemeContextValue>(() => ({mode, setMode, cycle}), [mode, setMode, cycle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error("useTheme must be used inside <ThemeProvider>.");
  return value;
}
