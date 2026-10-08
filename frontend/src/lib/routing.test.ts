import { describe, expect, it } from "vitest";

import type { Department } from "./departments";
import type { Employee } from "./employees";
import { chatHref, parseTarget, responderFor } from "./routing";

const person = (id: string, over: Partial<Employee> = {}): Employee => ({
  id,
  name: id,
  role: "Role",
  department: "marketing",
  seniority: "mid",
  desk_id: null,
  supervisor_id: null,
  avatar_seed: 1,
  status: "idle",
  status_detail: null,
  status_changed_at: "2026-10-08T00:00:00Z",
  ...over,
});

const marketing = { key: "marketing", name: "Marketing", director_id: "cmo" } as Department;

describe("responderFor", () => {
  it("routes a department to its director", () => {
    const r = responderFor({ kind: "department", department: "marketing" }, [person("cmo", { seniority: "executive" }), person("a")], [marketing]);
    expect(r.employee?.id).toBe("cmo");
    expect(r.via).toBe("director");
  });

  it("falls back to the most senior available member, never another department", () => {
    const team = [
      person("cmo", { seniority: "executive", status: "suspended" }),
      person("zed", { seniority: "senior" }),
      person("amy", { seniority: "senior" }),
      person("eng", { seniority: "executive", department: "engineering" }),
    ];
    const r = responderFor({ kind: "department", department: "marketing" }, team, [marketing]);
    expect(r.employee?.id).toBe("amy");
    expect(r.via).toBe("senior");
  });

  it("explains when nobody can answer", () => {
    const r = responderFor({ kind: "department", department: "marketing" }, [person("cmo", { status: "suspended" })], [marketing]);
    expect(r.employee).toBeNull();
    expect(r.unavailable).toMatch(/no available employee/);
    expect(responderFor({ kind: "employee", employee_id: "gone" }, [], []).unavailable).toMatch(/no longer works/);
    expect(responderFor({ kind: "employee", employee_id: "a" }, [person("a", { status: "suspended" })], []).unavailable).toMatch(/suspended/);
  });
});

describe("chat links", () => {
  it("round-trips targets through the URL", () => {
    expect(parseTarget("employee:emp_1")).toEqual({ kind: "employee", employee_id: "emp_1" });
    expect(parseTarget("department:sales")).toEqual({ kind: "department", department: "sales" });
    expect(parseTarget("ceo:x")).toBeNull();
    expect(parseTarget("employee")).toBeNull();
    expect(chatHref({ kind: "department", department: "sales" })).toBe("/chat?to=department:sales");
  });
});
