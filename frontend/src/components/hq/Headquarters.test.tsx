import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useOfficeStore } from "@/world/state/officeStore";

import { FloorStack } from "./Controls";
import { Headquarters } from "./Headquarters";
import { RoomFinder } from "./RoomFinder";
import { RoomPanel } from "./RoomPanel";

const initial = useOfficeStore.getState();

beforeEach(() => {
  useOfficeStore.setState(initial, true);
  // The status pill polls the backend; keep it offline in tests.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
});

describe("Headquarters without WebGL (jsdom)", () => {
  it("falls back to the 2D floor plan and says why", async () => {
    render(<Headquarters />);
    expect(await screen.findByTestId("floor-plan-2d")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("doesn't support WebGL2");
    expect(screen.getByRole("button", { name: "3D" })).toBeDisabled();
  });

  it("shows every room in the plan and opens details on click", async () => {
    render(<Headquarters />);
    const plan = await screen.findByTestId("floor-plan-2d");
    for (const name of ["Reception", "Sales", "Marketing", "Executive Office", "Meeting Room", "Engineering"]) {
      expect(within(plan).getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    fireEvent.click(within(plan).getByRole("button", { name: /^Engineering/ }));
    const panel = await screen.findByTestId("room-panel");
    expect(within(panel).getByRole("heading", { name: "Engineering" })).toBeInTheDocument();
  });
});

describe("RoomPanel", () => {
  it("reports only real facts and empty state", () => {
    useOfficeStore.getState().selectRoom("sales");
    render(<RoomPanel />);
    const panel = screen.getByTestId("room-panel");
    expect(panel).toHaveTextContent("Workstations8");
    expect(panel).toHaveTextContent("110 m²");
    expect(panel).toHaveTextContent("No AI employees assigned yet");
    expect(panel).toHaveTextContent("No active work");
    fireEvent.click(screen.getByRole("button", { name: "Close room details" }));
    expect(useOfficeStore.getState().selectedRoomId).toBeNull();
  });

  it("describes amenities without implying work", () => {
    useOfficeStore.getState().selectRoom("cafe");
    render(<RoomPanel />);
    expect(screen.getByTestId("room-panel")).not.toHaveTextContent("Team");
  });
});

describe("FloorStack", () => {
  it("marks the active floor and switches floors", () => {
    render(<FloorStack />);
    expect(screen.getByRole("button", { name: "All floors (overview)" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Ground/ }));
    expect(useOfficeStore.getState().activeFloor).toBe("L1");
  });
});

describe("RoomFinder", () => {
  it("filters rooms and selects with the keyboard", () => {
    render(<RoomFinder />);
    const input = screen.getByRole("combobox", { name: "Find a room or department" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "lou" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Employee Lounge");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useOfficeStore.getState().selectedRoomId).toBe("lounge");
    expect(useOfficeStore.getState().activeFloor).toBe("L1");
  });

  it("says when nothing matches", () => {
    render(<RoomFinder />);
    const input = screen.getByRole("combobox", { name: "Find a room or department" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText(/No rooms match/)).toBeInTheDocument();
  });
});
