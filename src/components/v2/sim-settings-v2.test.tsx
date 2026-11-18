// The V2 simulation's settings (SimSettingsButton), as the Traffic panel uses it: what a switch, a slider, a reset and the seed
// hand back to the plan (setParams), only what differs from the defaults kept; read-only, nothing to change.
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SimParams } from "@/lib/lane-sketch-sim";
import { sketchUi } from "@/state/sketch-ui";
import { SimSettingsButton } from "./sim-settings-v2";

function setup(start: SimParams = { rate: 300, speed: 50 }, readOnly = false) {
  sketchUi.getValue().editors.plan.dialogs.settings = false;
  const got = vi.fn<(p: SimParams) => void>();
  function Panel() {
    const [params, setParams] = useState(start);
    return <SimSettingsButton params={params} readOnly={readOnly} setParams={p => { got(p); setParams(p); }} />;
  }
  render(<Panel />);
  return { got, last: () => got.mock.calls.at(-1)![0], user: userEvent.setup() };
}
const openIt = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole("button", { name: /Simulation settings/ })); return screen.getByRole("dialog"); };

describe("SimSettingsButton", () => {
  it("the button counts what differs from the defaults; it opens the settings", async () => {
    const { user } = setup({ rate: 300, speed: 50, seed: 7, tune: { yieldGap: 2, junctionRules: 1 } });
    expect(screen.getByRole("button", { name: /Simulation settings/ }).textContent).toContain("3 changed");
    const d = await openIt(user);
    expect(within(d).getByText(/Simulation settings · Plan/)).toBeTruthy();
  });

  it("a switch: Priority sets junctionRules 1; back to First come, nothing left in tune", async () => {
    const { user, last } = setup();
    const d = await openIt(user);
    const rules = within(d).getByRole("radiogroup", { name: "Junction rules" });
    await user.click(within(rules).getByRole("radio", { name: "Priority" }));
    expect(last().tune).toEqual({ junctionRules: 1 });
    await user.click(within(rules).getByRole("radio", { name: "First come" }));
    expect(last().tune).toBeUndefined();
    expect(last()).toMatchObject({ rate: 300, speed: 50 });
  });

  it("a slider moved by a step with the keyboard; its reset puts the default back", async () => {
    const { user, last } = setup();
    const d = await openIt(user);
    const slider = within(d).getByRole("slider", { name: "Speed up to a yield line (m/s)" });
    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(last().tune).toEqual({ yieldSpeed: 4.5 });
    expect(within(d).getByText("4.5 m/s")).toBeTruthy();
    await user.click(within(d).getByRole("button", { name: "Reset Speed up to a yield line to 4.0 m/s" }));
    expect(last().tune).toBeUndefined();
  });

  it("Reset all takes every change back, the seed kept", async () => {
    const { user, last } = setup({ rate: 300, speed: 50, seed: 7, tune: { yieldGap: 2, junctionRules: 1 } });
    const d = await openIt(user);
    await user.click(within(d).getByRole("button", { name: /Reset all/ }));
    expect(last()).toEqual({ rate: 300, speed: 50, seed: 7 });
    expect(within(d).getByRole("button", { name: /Reset all/ }).hasAttribute("disabled")).toBe(true);
  });

  it("the seed: a number typed and Enter is the seed; anything else goes back to it", async () => {
    const { user, got, last } = setup();
    const d = await openIt(user);
    const seed = within(d).getByLabelText("Random seed");
    await user.clear(seed);
    await user.type(seed, "42{Enter}");
    expect(last().seed).toBe(42);
    const n = got.mock.calls.length;
    await user.clear(seed);
    await user.type(seed, "abc{Enter}");
    expect(got.mock.calls.length).toBe(n);
    expect((seed as HTMLInputElement).value).toBe("42");
  });

  it("read-only: everything there to see, nothing to change", async () => {
    const { user, got } = setup({ rate: 300, speed: 50, tune: { yieldGap: 2 } }, true);
    const d = await openIt(user);
    expect((within(d).getByLabelText("Random seed") as HTMLInputElement).disabled).toBe(true);
    expect(within(d).getByRole("button", { name: /Reset all/ }).hasAttribute("disabled")).toBe(true);
    expect(within(d).getByRole("button", { name: /New seed/ }).hasAttribute("disabled")).toBe(true);
    await user.click(within(within(d).getByRole("radiogroup", { name: "Junction rules" })).getByRole("radio", { name: "Priority" }));
    expect(got).not.toHaveBeenCalled();
  });
});
