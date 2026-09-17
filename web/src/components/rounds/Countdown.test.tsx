// The countdown announces only at the SPEC §9.7 thresholds, never every second.

import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Countdown} from "./Countdown.tsx";

/** The polite live region's text; empty means nothing was announced. */
function announced(container: HTMLElement): string {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

describe("Countdown", () => {
  it("shows the remaining time as a fixed-width clock", () => {
    render(<Countdown remaining={183_605n} />);
    expect(screen.getByText("2d 03:00:05")).toBeInTheDocument();
    expect(screen.getByText("Time until the cutoff")).toBeInTheDocument();
  });

  it("announces nothing while the remaining time only ticks", () => {
    const {container, rerender} = render(<Countdown remaining={7_200n} announce />);
    expect(announced(container)).toBe("");
    rerender(<Countdown remaining={7_199n} announce />);
    rerender(<Countdown remaining={7_198n} announce />);
    expect(announced(container)).toBe("");
  });

  it("announces once at each of the four thresholds and not between them", () => {
    const {container, rerender} = render(<Countdown remaining={3_601n} announce />);
    expect(announced(container)).toBe("");

    rerender(<Countdown remaining={3_600n} announce />);
    expect(announced(container)).toBe("One hour left before this round's cutoff.");

    // Still inside the same bucket: the region keeps its previous sentence rather than repeating.
    rerender(<Countdown remaining={1_800n} announce />);
    expect(announced(container)).toBe("One hour left before this round's cutoff.");

    rerender(<Countdown remaining={600n} announce />);
    expect(announced(container)).toBe("Ten minutes left before this round's cutoff.");

    rerender(<Countdown remaining={60n} announce />);
    expect(announced(container)).toBe("One minute left before this round's cutoff.");

    rerender(<Countdown remaining={0n} announce />);
    expect(announced(container)).toBe("This round's cutoff has passed.");
  });

  it("has no live region at all when the caller does not ask for one", () => {
    const {container} = render(<Countdown remaining={60n} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
