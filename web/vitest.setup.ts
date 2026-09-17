// Test environment setup: DOM matchers, automatic unmount between tests, and the two browser APIs jsdom
// does not implement that the app touches (matchMedia for the theme, randomUUID for connector ids).

import "@testing-library/jest-dom/vitest";
import {cleanup} from "@testing-library/react";
import {afterEach, beforeEach, vi} from "vitest";

beforeEach(() => {
  if (typeof window !== "undefined" && window.matchMedia === undefined) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: () => false,
      }),
    });
  }
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
