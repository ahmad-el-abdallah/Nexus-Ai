import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Employee } from "@/lib/employees";
import { useEmployeeStore } from "@/world/state/employeeStore";
import { useOfficeStore } from "@/world/state/officeStore";
import { useStorageStore } from "@/world/state/storageStore";

import { FloorStack } from "./Controls";
import { EmployeePanel } from "./EmployeePanel";
import { Headquarters } from "./Headquarters";
import { RoomFinder } from "./RoomFinder";
import { RoomPanel } from "./RoomPanel";

const initial = useOfficeStore.getState();
const initialEmployees = useEmployeeStore.getState();
const initialStorage = useStorageStore.getState();

const person = (over: Partial<Employee> = {}): Employee => ({
  id: "emp_aaaaaaaaaaaa",
  name: "Priya Nair",
  role: "Sales Development Representative",
  department: "sales",
  seniority: "mid",
  desk_id: "sales-desk-2",
  supervisor_id: null,
  avatar_seed: 202,
  status: "idle",
  status_detail: null,
  status_changed_at: new Date().toISOString(),
  ...over,
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  useOfficeStore.setState(initial, true);
  useEmployeeStore.setState(initialEmployees, true);
  useStorageStore.setState(initialStorage, true);
  // The status pill polls the backend; keep it offline in tests.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
});

describe("Headquarters without WebGL (jsdom)", () => {
  it("falls back to the 2D floor plan and says why", async () => {
    render(<Headquarters />);
    expect(await screen.findByTestId("floor-plan-2d")).toBeInTheDocument();
    expect(screen.getAllByRole("status").some((el) => el.textContent?.includes("doesn't support WebGL2"))).toBe(true);
    expect(screen.getByRole("button", { name: "3D" })).toBeDisabled();
  });

  it("shows every room in the plan and opens details on click", async () => {
    render(<Headquarters />);
    const plan = await screen.findByTestId("floor-plan-2d");
    for (const name of ["Reception", "Sales", "Marketing", "Executive Office", "Meeting Room", "Engineering", "Data Center"]) {
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
    expect(panel).toHaveTextContent("0 of 8 desks filled");
    expect(panel).toHaveTextContent("No active work");
    fireEvent.click(screen.getByRole("button", { name: "Close room details" }));
    expect(useOfficeStore.getState().selectedRoomId).toBeNull();
  });

  it("lists the room's real team", () => {
    useEmployeeStore.setState({ employees: [person(), person({ id: "emp_bbbbbbbbbbbb", name: "Marcus Bell", desk_id: "sales-desk-1", status: "suspended" })], load: "ready" });
    useOfficeStore.getState().selectRoom("sales");
    render(<RoomPanel />);
    const panel = screen.getByTestId("room-panel");
    expect(panel).toHaveTextContent("2 of 8 desks filled");
    expect(panel).toHaveTextContent("Priya Nair");
    expect(panel).toHaveTextContent("Suspended");
    fireEvent.click(within(panel).getByRole("button", { name: /Marcus Bell/ }));
    expect(useOfficeStore.getState().selectedEmployeeId).toBe("emp_bbbbbbbbbbbb");
    expect(useOfficeStore.getState().selectedRoomId).toBeNull();
  });

  it("says when the roster can't be loaded", () => {
    useEmployeeStore.setState({ employees: [], load: "error", error: "Backend is unreachable" });
    useOfficeStore.getState().selectRoom("engineering");
    render(<RoomPanel />);
    expect(screen.getByTestId("room-panel")).toHaveTextContent("Roster unavailable (backend offline)");
  });

  it("describes amenities without implying work", () => {
    useOfficeStore.getState().selectRoom("cafe");
    render(<RoomPanel />);
    expect(screen.getByTestId("room-panel")).not.toHaveTextContent("Team");
  });

  it("shows real read-only storage metadata in the Data Center", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          status: "metadata_ready",
          backend: "local",
          writes_enabled: true,
          workspace_count: 21,
          department_workspace_count: 20,
          entry_count: 3,
          file_count: 2,
          folder_count: 1,
          version_count: 4,
          active_grant_count: 2,
          linked_entry_count: 1,
          read_only_workspace_count: 0,
          stored_bytes: 1536,
          quota_bytes_per_department: 10 * 1024 * 1024 * 1024,
          backup_configured: false,
          backup_snapshot_count: 0,
          last_backup_at: null,
          unavailable_version_count: 0,
          integrity_checked_at: null,
          last_event_at: null,
        }),
      ),
    );
    useOfficeStore.getState().selectRoom("data-center");
    render(<RoomPanel />);
    const panel = screen.getByTestId("room-panel");
    expect(within(panel).getByRole("heading", { name: "Data Center" })).toBeInTheDocument();
    expect(await within(panel).findByText("Metadata online")).toBeInTheDocument();
    expect(panel).toHaveTextContent("Workspaces21");
    expect(panel).toHaveTextContent("Files2");
    expect(panel).toHaveTextContent("Access grants2");
    expect(panel).toHaveTextContent("Linked items1");
    expect(panel).toHaveTextContent("Stored1.5 KiB");
    expect(panel).toHaveTextContent("No storage activity has been recorded yet");
    expect(within(panel).getByText("Storage operations are available through the owner API.")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: /Open Digital Vault explorer/ })).toHaveAttribute("href", "/vault");
    expect(panel).not.toHaveTextContent("Team");
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
    const input = screen.getByRole("combobox", { name: "Find a room, department or employee" });
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
    const input = screen.getByRole("combobox", { name: "Find a room, department or employee" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("finds people by name or role and selects them", () => {
    useEmployeeStore.setState({ employees: [person()], load: "ready" });
    render(<RoomFinder />);
    const input = screen.getByRole("combobox", { name: "Find a room, department or employee" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "development rep" } });
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Priya Nair");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useOfficeStore.getState().selectedEmployeeId).toBe("emp_aaaaaaaaaaaa");
  });
});

describe("EmployeePanel", () => {
  it("shows recorded facts and the honest status", async () => {
    useEmployeeStore.setState({ employees: [person()], load: "ready" });
    useOfficeStore.getState().selectEmployee("emp_aaaaaaaaaaaa", false);
    render(<EmployeePanel />);
    const panel = screen.getByTestId("employee-panel");
    expect(within(panel).getByRole("heading", { name: "Priya Nair" })).toBeInTheDocument();
    expect(screen.getByTestId("employee-status")).toHaveTextContent("Idle");
    expect(panel).toHaveTextContent("Sales · desk 2");
    expect(panel).toHaveTextContent("AI modelNone selected");
    expect(await screen.findByTestId("current-task")).toHaveTextContent("Current taskNone");
  });

  it("suspends through the backend and reflects the saved status", async () => {
    const fetchMock = vi.fn(async () => json(person({ status: "suspended", status_detail: "Suspended by the owner" })));
    vi.stubGlobal("fetch", fetchMock);
    useEmployeeStore.setState({ employees: [person()], load: "ready" });
    useOfficeStore.getState().selectEmployee("emp_aaaaaaaaaaaa", false);
    render(<EmployeePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Suspend employee" }));
    expect(await screen.findByRole("button", { name: "Activate employee" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/employees/emp_aaaaaaaaaaaa/suspend", expect.objectContaining({ method: "POST" }));
    expect(screen.getByTestId("employee-status")).toHaveTextContent("Suspended");
    expect(screen.getByTestId("employee-panel")).toHaveTextContent("Suspended by the owner");
  });

  it("shows backend errors instead of pretending the action worked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "Employee is already suspended" }, 409)));
    useEmployeeStore.setState({ employees: [person()], load: "ready" });
    useOfficeStore.getState().selectEmployee("emp_aaaaaaaaaaaa", false);
    render(<EmployeePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Suspend employee" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Employee is already suspended");
    expect(screen.getByTestId("employee-status")).toHaveTextContent("Idle");
  });
});
