import { beforeEach, describe, expect, it } from "vitest";

import { useOfficeStore } from "./officeStore";

const initial = useOfficeStore.getState();

describe("office store", () => {
  beforeEach(() => useOfficeStore.setState(initial, true));

  it("selects a visible room without changing floors", () => {
    useOfficeStore.getState().selectRoom("engineering");
    const s = useOfficeStore.getState();
    expect(s.selectedRoomId).toBe("engineering");
    expect(s.activeFloor).toBe("all");
    expect(s.cameraRequest).toMatchObject({ kind: "room", roomId: "engineering" });
  });

  it("switches to the ground floor to reveal a room hidden under level 2", () => {
    useOfficeStore.getState().selectRoom("lounge");
    expect(useOfficeStore.getState().activeFloor).toBe("L1");
  });

  it("clears the selection when its room is hidden by a floor change", () => {
    const store = useOfficeStore.getState();
    store.selectRoom("engineering");
    store.setActiveFloor("L1");
    expect(useOfficeStore.getState().selectedRoomId).toBeNull();
    expect(useOfficeStore.getState().cameraRequest?.kind).toBe("floor");
  });

  it("returns to the headquarters overview", () => {
    const store = useOfficeStore.getState();
    store.selectRoom("lounge");
    store.resetView();
    const s = useOfficeStore.getState();
    expect(s.activeFloor).toBe("all");
    expect(s.selectedRoomId).toBeNull();
    expect(s.cameraRequest?.kind).toBe("overview");
  });

  it("issues a fresh camera request every time", () => {
    const store = useOfficeStore.getState();
    store.zoomBy(1.25);
    const first = useOfficeStore.getState().cameraRequest!.nonce;
    store.zoomBy(1.25);
    expect(useOfficeStore.getState().cameraRequest!.nonce).toBeGreaterThan(first);
  });

  it("falls back to the 2D plan when WebGL is unavailable or lost", () => {
    useOfficeStore.getState().setWebGL("unsupported");
    expect(useOfficeStore.getState().view).toBe("2d");
    useOfficeStore.setState(initial, true);
    useOfficeStore.getState().setWebGL("lost");
    expect(useOfficeStore.getState().view).toBe("2d");
  });

  it("ignores unknown room ids", () => {
    useOfficeStore.getState().selectRoom("does-not-exist");
    expect(useOfficeStore.getState().selectedRoomId).toBeNull();
  });
});
