// Ctrl+K search in the V2 editor (SketchSearch), as it is used: typed into, the arrows and Enter, a click, Esc. Its ranking alone is
// search:check's; here, what the user sees and what reaches the editor (onGo, onClose, a command run).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JunctionContents, Sketch } from "@/lib/lane-sketch";
import { sketchUi } from "@/state/sketch-ui";
import { SketchSearch } from "./sketch-search";

const line = (id: string, x0: number, x1: number) => ({ id, width: 3.5, shape: { kind: "line" as const, pts: [{ x: x0, y: 0 }, { x: x1, y: 0 }] } });
const sketch: Sketch = {
  lanes: [line("l709", 0, 50), line("l2382", 60, 120), line("l7", 130, 160)],
  connectors: [{ id: "c2011", from: { lane: "l709", s: 50 }, to: { lane: "l2382", s: 0 } }],
  roads: [{ id: "r1", name: "Strada Gării", lanes: ["l2382"] }, { id: "r2", name: "Calea Moldovei", lanes: ["l7"] }],
  junctions: [{ id: "j709", name: "Junction 709", outline: [] }],
};
const contents = new Map<string, JunctionContents>([["j709", { lanes: [], connectors: ["c2011"], roads: ["r1"] }]]);

function open(commands: { title: string; sub: string; run: () => void }[] = []) {
  const onGo = vi.fn(), onClose = vi.fn();
  // (opened afresh, as Ctrl+K does in the editor: the box empty)
  sketchUi.getValue().editors.plan.dialogs.search.query = "";
  render(<SketchSearch sketch={sketch} contents={contents} cars={[{ id: 709, edge: "lane:l7", kmh: 30 }]} commands={commands} onGo={onGo} onClose={onClose} />);
  return { onGo, onClose, box: screen.getByPlaceholderText(/^Search roads, junctions/), user: userEvent.setup() };
}
const options = () => screen.queryAllByRole("option").map(o => o.textContent);

describe("SketchSearch", () => {
  it("opens empty, the box focused, with how to use it", async () => {
    const { box } = open();
    await waitFor(() => expect(box).toHaveProperty("ownerDocument.activeElement", box));
    expect(options()).toEqual([]);
    expect(screen.getByText(/every word must match/)).toBeTruthy();
  });

  it("finds a road without its accents, and Enter goes to it and closes", async () => {
    const { box, user, onGo, onClose } = open();
    await user.type(box, "garii");
    expect(options()[0]).toContain("Strada Gării");
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onGo).toHaveBeenCalledWith({ kind: "road", id: "r1" });
  });

  it("the arrows move the pick: ↓ then Enter takes the second hit", async () => {
    const { box, user, onGo } = open();
    await user.type(box, "709");
    const hits = options();
    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0]).toContain("Junction 709");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Enter}");
    expect(onGo).toHaveBeenCalledOnce();
    expect(onGo.mock.calls[0][0]).not.toEqual({ kind: "junction", id: "j709" });
  });

  it("a car by its number with #; a click picks a row", async () => {
    const { box, user, onGo } = open();
    await user.type(box, "#709");
    const car = screen.getAllByRole("option").find(o => /car/i.test(o.textContent ?? ""));
    expect(car).toBeTruthy();
    await user.click(car!);
    expect(onGo).toHaveBeenCalledWith(expect.objectContaining({ kind: "car", id: 709 }));
  });

  it("says when nothing matches; Esc closes without going anywhere", async () => {
    const { box, user, onGo, onClose } = open();
    await user.type(box, "nowhere street");
    expect(options()).toEqual([]);
    expect(screen.getByText(/Nothing on the sketch matches/)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onGo).not.toHaveBeenCalled();
  });

  it("a command is found as the rest are, listed first, and run, not gone to", async () => {
    const run = vi.fn();
    const { box, user, onGo, onClose } = open([{ title: "Send a test car", sub: "from the selected lane", run }]);
    await user.type(box, "test");
    expect(options()[0]).toContain("Send a test car");
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onGo).not.toHaveBeenCalled();
  });
});
